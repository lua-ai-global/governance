/**
 * governance-sdk LlamaIndex Plugin
 *
 * Integrates governance enforcement into LlamaIndex tool execution.
 * Wraps tools with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governLlamaIndexTools } from 'governance-sdk/plugins/llamaindex';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['file_delete', 'shell_exec'])],
 * });
 *
 * const { tools } = await governLlamaIndexTools(gov, [searchTool, writeTool], {
 *   agentName: 'llamaindex-agent',
 *   owner: 'ai-team',
 * });
 *
 * // Use governed tools in your LlamaIndex agent
 * const agent = new OpenAIAgent({ tools });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  LlamaIndexTool, LlamaIndexAgent, LlamaIndexJSONValue,
  GovernLlamaIndexConfig, GovernedLlamaIndexToolsResult, GovernedLlamaIndexAgentResult,
} from "./llamaindex-types.js";

// Re-export all types
export type {
  LlamaIndexTool, LlamaIndexToolMetadata, LlamaIndexToolOutput, LlamaIndexJSONValue,
  LlamaIndexQueryEngineTool, LlamaIndexAgent,
  GovernLlamaIndexConfig, GovernedLlamaIndexToolsResult, GovernedLlamaIndexAgentResult,
} from "./llamaindex-types.js";

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

function buildRegistration(config: GovernLlamaIndexConfig, toolNames: string[]): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "custom",
    owner: config.owner,
    description: config.description,
    version: config.version,
    channels: config.channels,
    tools: toolNames,
    hasAuth: config.hasAuth,
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: true,
    permissions: config.permissions,
    metadata: { ...config.metadata, runtime: "llamaindex" },
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernLlamaIndexConfig) {
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
  tool: LlamaIndexTool,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
): LlamaIndexTool {
  if (!tool.call) return tool;
  const toolName = tool.metadata.name;
  return {
    ...tool,
    call: async (input: Record<string, unknown>): Promise<LlamaIndexJSONValue> => {
      const decision = await enforce(toolName, input);
      if (decision.blocked) throw new GovernanceBlockedError(decision, toolName);
      try {
        const output = await tool.call!(input);
        await audit(toolName, "success");
        return output;
      } catch (error) {
        await audit(toolName, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}

// ─── Govern LlamaIndex Tools ────────────────────────────────

export async function governLlamaIndexTools(
  governance: GovernanceInstance,
  tools: LlamaIndexTool[],
  config: GovernLlamaIndexConfig,
): Promise<GovernedLlamaIndexToolsResult> {
  const toolNames = tools.map((t) => t.metadata.name);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  return {
    tools: tools.map((tool) => wrapTool(tool, enforce, audit)),
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}

// ─── Govern LlamaIndex Agent ────────────────────────────────

export async function governLlamaIndexAgent(
  governance: GovernanceInstance,
  agent: LlamaIndexAgent,
  config: GovernLlamaIndexConfig,
): Promise<GovernedLlamaIndexAgentResult> {
  const toolNames = agent.tools.map((t) => t.metadata.name);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  return {
    agent: { ...agent, tools: agent.tools.map((tool) => wrapTool(tool, enforce, audit)) },
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}
