/**
 * governance-sdk MCP (Model Context Protocol) Plugin
 *
 * Integrates governance enforcement into MCP servers.
 * Governs tool calls and resource reads with before-action policy checks.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { createGovernedMCP } from 'governance-sdk/plugins/mcp';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec', 'file_delete'])],
 * });
 *
 * const { handleToolCall } = await createGovernedMCP(gov, originalHandler, {
 *   agentName: 'my-mcp-server',
 *   owner: 'platform-team',
 * });
 *
 * // Use handleToolCall as your server's tools/call handler
 * server.setRequestHandler('tools/call', handleToolCall);
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import { detectInjection } from "../injection-detect.js";
import type {
  MCPCallToolRequest,
  MCPCallToolResult,
  MCPReadResourceRequest,
  MCPContent,
  GovernMCPConfig,
  GovernedMCPResult,
  MCPToolCallHandler,
  MCPResourceReadHandler,
} from "./mcp-types.js";

// Re-export all types
export type {
  MCPCallToolRequest, MCPCallToolResult, MCPContent,
  MCPReadResourceRequest, MCPToolDefinition,
  GovernMCPConfig, GovernedMCPResult,
  MCPToolCallHandler, MCPResourceReadHandler,
} from "./mcp-types.js";

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernMCPConfig): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "mcp",
    owner: config.owner,
    description: config.description,
    version: config.version,
    channels: config.channels,
    tools: config.tools,
    hasAuth: config.hasAuth,
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: true,
    permissions: config.permissions,
    metadata: config.metadata,
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernMCPConfig) {
  return async (toolName: string, input?: Record<string, unknown>): Promise<EnforcementDecision> => {
    const action = config.actionMapper?.(toolName) ?? ("tool_call" as PolicyAction);
    const decision = await governance.enforce({
      agentId, agentName: config.agentName, agentLevel: 0,
      action, tool: toolName, input,
      sessionTokensUsed: config.sessionTokenTracker?.(),
    });
    handleOutcome(decision, toolName, config as OutcomeCallbacks);
    return decision;
  };
}

function createAuditor(governance: GovernanceInstance, agentId: string) {
  return (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>): Promise<AuditEvent> =>
    governance.audit.log({
      agentId, eventType: "tool_call", outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: { tool: toolName, ...detail },
    });
}

// ─── Create Governed MCP ────────────────────────────────────

/**
 * Create a governed MCP server handler.
 *
 * Wraps an existing tool call handler with governance enforcement.
 * Each tool call is checked against policies before execution.
 */
export async function createGovernedMCP(
  governance: GovernanceInstance,
  toolCallHandler: MCPToolCallHandler,
  config: GovernMCPConfig,
  resourceReadHandler?: MCPResourceReadHandler,
): Promise<GovernedMCPResult> {
  const reg = buildRegistration(config);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  const governResources = config.governResources !== false;

  async function handleToolCall(request: MCPCallToolRequest): Promise<MCPCallToolResult> {
    const toolName = request.params.name;
    const args = request.params.arguments;

    // Input pre-scan — symmetric to the output injection scan below.
    // Walks the incoming tool arguments for textual fields and scans each
    // for injection patterns BEFORE we call the tool handler. On detection
    // we block with a GovernanceBlockedError so the caller sees a structured
    // failure (audit event + policy violation) rather than silent pass-through.
    if (config.scanToolInputs !== false) {
      const textInputs = collectTextInputs(args);
      for (const text of textInputs) {
        const scan = detectInjection(text, {
          threshold: config.inputInjectionThreshold ?? 0.6,
        });
        if (scan.detected) {
          await audit(toolName, "failure", {
            injectionInInput: true, score: scan.score, patterns: scan.patterns,
          });
          throw new GovernanceBlockedError(
            {
              blocked: true,
              reason: `Injection detected in tool input (score: ${scan.score})`,
              ruleId: null,
              outcome: "block",
              evaluatedAt: new Date().toISOString(),
              rulesEvaluated: 0,
            },
            toolName,
          );
        }
      }
    }

    await enforce(toolName, args);

    try {
      const output = await toolCallHandler(request);

      // Scan text content in tool output for injection patterns
      if (config.scanToolOutputs !== false) {
        for (const block of output.content) {
          if (block.type === "text" && block.text) {
            const scan = detectInjection(block.text, { threshold: config.outputInjectionThreshold ?? 0.6 });
            if (scan.detected) {
              await audit(toolName, "failure", {
                injectionInOutput: true, score: scan.score, patterns: scan.patterns,
              });
              throw new GovernanceBlockedError(
                { blocked: true, reason: `Injection detected in tool output (score: ${scan.score})`, ruleId: null, outcome: "block", evaluatedAt: new Date().toISOString(), rulesEvaluated: 0 },
                toolName,
              );
            }
          }
        }
      }

      await audit(toolName, output.isError ? "failure" : "success", {
        contentTypes: output.content.map((c) => c.type),
      });
      return output;
    } catch (error) {
      await audit(toolName, "failure", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function handleResourceRead(request: MCPReadResourceRequest): Promise<MCPContent[]> {
    if (governResources && resourceReadHandler) {
      const uri = request.params.uri;
      const resourceAction = config.resourceActionMapper?.(uri) ?? ("data_access" as PolicyAction);

      const decision = await governance.enforce({
        agentId: result.id, agentName: config.agentName, agentLevel: 0,
        action: resourceAction, tool: uri,
        metadata: { resourceUri: uri },
      });

      handleOutcome(decision, uri, config as OutcomeCallbacks);
    }

    if (!resourceReadHandler) {
      return [{ type: "text", text: "No resource handler configured" }];
    }

    try {
      const content = await resourceReadHandler(request);
      await audit(request.params.uri, "success", { type: "resource_read" });
      return content;
    } catch (error) {
      await audit(request.params.uri, "failure", {
        type: "resource_read",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {
    handleToolCall,
    handleResourceRead,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}

// ─── Utilities ─────────────────────────────────────────────────

/**
 * Walk an arbitrary tool-call arguments object and collect every string leaf
 * for injection scanning. Handles nested objects and arrays. Skips short
 * strings that are unlikely to contain meaningful payloads.
 */
function collectTextInputs(args: unknown, depth = 0): string[] {
  if (depth > 10) return []; // guard against pathological nesting
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.length >= 8) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) visit(val);
    }
  };
  visit(args);
  return out;
}
