/**
 * governance-sdk OpenAI Agents SDK Plugin
 *
 * Integrates governance enforcement into OpenAI Agents SDK tool execution.
 * Wraps tools with before-action policy checks and audit logging.
 * Types are in openai-agents-types.ts.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governAgent } from 'governance-sdk/plugins/openai-agents';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec', 'database_drop'])],
 * });
 *
 * const governed = await governAgent(gov, {
 *   name: 'research-agent',
 *   tools: [webSearchTool, fileWriteTool],
 * }, {
 *   agentName: 'research-agent',
 *   owner: 'research-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  OpenAIFunctionTool,
  OpenAIAgent,
  GovernAgentConfig,
  GovernedAgentResult,
  GovernedToolsResult,
} from "./openai-agents-types.js";

// Re-export all types for consumers
export type {
  OpenAIFunctionTool, OpenAIAgent, OpenAIRunContext, OpenAIToolCallDetails,
  GovernAgentConfig, GovernedAgentResult, GovernedToolsResult,
} from "./openai-agents-types.js";

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { scanToolResult } from "../tool-result-scan.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Pre/post guardrails ────────────────────────────────────
// See ./openai-agents-guardrails.ts for docs + examples.
export type {
  OpenAIInputGuardrail,
  OpenAIOutputGuardrail,
  OpenAIGuardrailConfig,
  GuardrailOutputInfo,
} from "./openai-agents-guardrails.js";
export {
  createInputGuardrail,
  createOutputGuardrail,
} from "./openai-agents-guardrails.js";

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernAgentConfig, toolNames: string[], description?: string): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "openai",
    owner: config.owner,
    description: config.description ?? description,
    version: config.version,
    channels: config.channels,
    tools: toolNames,
    hasAuth: config.hasAuth,
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: true,
    permissions: config.permissions,
    metadata: config.metadata,
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernAgentConfig) {
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

/**
 * Build a result-scan closure bound to this governance + agent. Runs
 * the tool's raw output through the policy engine at stage `tool_result`
 * and returns either the original (allow) or a redacted detail object
 * (block). No-op when `config.scanToolResults === false`.
 */
function createResultScanner(
  governance: GovernanceInstance, agentId: string, config: GovernAgentConfig,
) {
  return async (toolName: string, args: Record<string, unknown> | undefined, output: unknown): Promise<unknown> => {
    if (config.scanToolResults === false) return output;
    const scanned = await scanToolResult({
      governance, agentId, agentName: config.agentName, tool: toolName,
      args, result: output,
      injectionThreshold: config.toolResultInjectionThreshold,
    });
    return scanned.result;
  };
}

function wrapTool(
  tool: OpenAIFunctionTool,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
  scanResult: ReturnType<typeof createResultScanner>,
): OpenAIFunctionTool {
  const hasHandler = tool.invoke ?? tool.execute;
  if (!hasHandler) return tool;

  const wrapped: OpenAIFunctionTool = { ...tool };

  // Wrap invoke (SDK canonical method — args is JSON string, optional details)
  if (tool.invoke) {
    wrapped.invoke = async (ctx, args, details) => {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const decision = await enforce(tool.name, parsed);
      try {
        const output = await tool.invoke!(ctx, args, details);
        const finalOutput = await scanResult(tool.name, parsed, output);
        await audit(tool.name, "success");
        return finalOutput;
      } catch (error) {
        await audit(tool.name, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
  }

  // Wrap legacy execute (governance wrapper convenience — does not exist in SDK)
  if (tool.execute) {
    wrapped.execute = async (args: Record<string, unknown>) => {
      const decision = await enforce(tool.name, args);
      try {
        const output = await tool.execute!(args);
        const finalOutput = await scanResult(tool.name, args, output);
        await audit(tool.name, "success");
        return finalOutput;
      } catch (error) {
        await audit(tool.name, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
  }

  return wrapped;
}

// ─── Govern Agent ───────────────────────────────────────────

export async function governAgent<T extends OpenAIAgent>(
  governance: GovernanceInstance,
  agent: T,
  config: GovernAgentConfig,
): Promise<GovernedAgentResult<T>> {
  const toolNames = (agent.tools ?? []).filter((t): t is OpenAIFunctionTool => t.type === "function").map((t) => t.name);
  const desc = typeof agent.instructions === "string" ? agent.instructions : undefined;
  const reg = buildRegistration(config, toolNames, desc);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);
  const scanResult = createResultScanner(governance, result.id, config);
  const wrappedTools = (agent.tools ?? []).map((tool) => tool.type === "function" ? wrapTool(tool, enforce, audit, scanResult) : tool);

  return {
    agent: { ...agent, tools: wrappedTools } as T,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}

// ─── Govern Tools Only ──────────────────────────────────────

export async function governTools(
  governance: GovernanceInstance,
  tools: OpenAIFunctionTool[],
  config: GovernAgentConfig,
): Promise<GovernedToolsResult> {
  const toolNames = tools.map((t) => t.name);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);
  const scanResult = createResultScanner(governance, result.id, config);

  return {
    tools: tools.map((tool) => wrapTool(tool, enforce, audit, scanResult)),
    agentId: result.id,
    score: result.score,
    level: result.level,
  };
}
