/**
 * governance-sdk Ollama Plugin
 *
 * Integrates governance enforcement into Ollama tool execution.
 * Wraps tool executors with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governOllamaTools } from 'governance-sdk/plugins/ollama';
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

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

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
    try {
      await enforce(toolCall.function.name, args);
      const output = await executor.execute(args);
      await audit(toolCall.function.name, "success");
      return typeof output === "string" ? output : JSON.stringify(output);
    } catch (error) {
      if (error instanceof GovernanceBlockedError || error instanceof GovernanceApprovalRequiredError) {
        await audit(toolCall.function.name, "failure", { reason: (error as GovernanceBlockedError).decision.reason });
        return `Blocked: ${(error as GovernanceBlockedError).decision.reason}`;
      }
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
