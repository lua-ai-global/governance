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

function wrapTool(
  tool: OpenAIFunctionTool,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
): OpenAIFunctionTool {
  const hasHandler = tool.invoke ?? tool.execute;
  if (!hasHandler) return tool;

  const wrapped: OpenAIFunctionTool = { ...tool };

  // Wrap invoke (SDK canonical method — args is JSON string, optional details)
  if (tool.invoke) {
    wrapped.invoke = async (ctx, args, details) => {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const decision = await enforce(tool.name, parsed);
      if (decision.blocked) throw new GovernanceBlockedError(decision, tool.name);
      try {
        const output = await tool.invoke!(ctx, args, details);
        await audit(tool.name, "success");
        return output;
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
      if (decision.blocked) throw new GovernanceBlockedError(decision, tool.name);
      try {
        const output = await tool.execute!(args);
        await audit(tool.name, "success");
        return output;
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
  const wrappedTools = (agent.tools ?? []).map((tool) => tool.type === "function" ? wrapTool(tool, enforce, audit) : tool);

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

  return {
    tools: tools.map((tool) => wrapTool(tool, enforce, audit)),
    agentId: result.id,
    score: result.score,
    level: result.level,
  };
}
