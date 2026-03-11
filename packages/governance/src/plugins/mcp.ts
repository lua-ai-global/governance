/**
 * @lua-ai-global/governance MCP (Model Context Protocol) Plugin
 *
 * Integrates governance enforcement into MCP servers.
 * Governs tool calls and resource reads with before-action policy checks.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from '@lua-ai-global/governance';
 * import { createGovernedMCP } from '@lua-ai-global/governance/plugins/mcp';
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
import type {
  MCPCallToolRequest,
  MCPCallToolResult,
  MCPReadResourceRequest,
  MCPContent,
  GovernMCPConfig,
  GovernedMCPResult,
  MCPToolCallHandler,
  MCPResourceReadHandler,
} from "./mcp-types";

// Re-export all types
export type {
  MCPCallToolRequest, MCPCallToolResult, MCPContent,
  MCPReadResourceRequest, MCPToolDefinition,
  GovernMCPConfig, GovernedMCPResult,
  MCPToolCallHandler, MCPResourceReadHandler,
} from "./mcp-types";

// ─── Blocked Error ──────────────────────────────────────────

export class GovernanceBlockedError extends Error {
  public readonly decision: EnforcementDecision;
  public readonly toolName: string;

  constructor(decision: EnforcementDecision, toolName: string) {
    super(`Governance blocked: ${decision.reason} (tool: ${toolName})`);
    this.name = "GovernanceBlockedError";
    this.decision = decision;
    this.toolName = toolName;
  }
}

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
    config.onDecision?.(decision, toolName);
    if (decision.blocked) config.onBlocked?.(decision, toolName);
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

    const decision = await enforce(toolName, args);
    if (decision.blocked) {
      throw new GovernanceBlockedError(decision, toolName);
    }

    try {
      const output = await toolCallHandler(request);
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

      config.onDecision?.(decision, uri);
      if (decision.blocked) {
        config.onBlocked?.(decision, uri);
        throw new GovernanceBlockedError(decision, uri);
      }
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
