/**
 * @lua-ai-global/governance Ollama Plugin
 *
 * Integrates governance enforcement into Ollama tool execution.
 * Wraps tool executors with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from '@lua-ai-global/governance';
 * import { governOllamaTools } from '@lua-ai-global/governance/plugins/ollama';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec'])],
 * });
 *
 * const { tools, handleToolCall } = await governOllamaTools(gov, myTools, {
 *   agentName: 'ollama-agent',
 *   owner: 'local-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  OllamaToolExecutor, OllamaToolCall,
  GovernOllamaConfig, GovernedOllamaResult,
} from "./ollama-types.js";

// Re-export all types
export type {
  OllamaToolDefinition, OllamaToolCall, OllamaToolExecutor,
  GovernOllamaConfig, GovernedOllamaResult,
} from "./ollama-types.js";

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

function buildRegistration(config: GovernOllamaConfig, toolNames: string[]): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "ollama",
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
    metadata: config.metadata,
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernOllamaConfig) {
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

// ─── Main Export ────────────────────────────────────────────

export async function governOllamaTools(
  governance: GovernanceInstance,
  tools: OllamaToolExecutor[],
  config: GovernOllamaConfig,
): Promise<GovernedOllamaResult> {
  const toolNames = tools.map((t) => t.name);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const governedTools: OllamaToolExecutor[] = tools.map((tool) => ({
    ...tool,
    execute: async (args: Record<string, unknown>) => {
      const decision = await enforce(tool.name, args);
      if (decision.blocked) throw new GovernanceBlockedError(decision, tool.name);
      try {
        const output = await tool.execute(args);
        await audit(tool.name, "success");
        return output;
      } catch (error) {
        await audit(tool.name, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  }));

  async function handleToolCall(toolCall: OllamaToolCall): Promise<string> {
    const executor = toolMap.get(toolCall.function.name);
    if (!executor) {
      return `Unknown tool: ${toolCall.function.name}`;
    }
    const args = toolCall.function.arguments;
    const decision = await enforce(toolCall.function.name, args);
    if (decision.blocked) {
      await audit(toolCall.function.name, "failure", { reason: decision.reason });
      return `Blocked: ${decision.reason}`;
    }
    try {
      const output = await executor.execute(args);
      await audit(toolCall.function.name, "success");
      return typeof output === "string" ? output : JSON.stringify(output);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await audit(toolCall.function.name, "failure", { error: msg });
      return msg;
    }
  }

  return {
    tools: governedTools,
    handleToolCall,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}
