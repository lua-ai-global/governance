/**
 * governance-sdk Anthropic Claude SDK Plugin
 *
 * Integrates governance enforcement into Anthropic Claude tool execution.
 * Wraps tool executors with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governAnthropicTools } from 'governance-sdk/plugins/anthropic';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['file_write'])],
 * });
 *
 * const { tools, handleToolUse } = await governAnthropicTools(gov, myTools, {
 *   agentName: 'claude-assistant',
 *   owner: 'ai-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  AnthropicToolExecutor, AnthropicToolUseBlock, AnthropicToolResultBlock,
  GovernAnthropicConfig, GovernedAnthropicResult,
} from "./anthropic-types.js";

// Re-export all types
export type {
  AnthropicToolDefinition, AnthropicToolUseBlock, AnthropicToolResultBlock,
  AnthropicContentBlock, AnthropicContentBlockParam, AnthropicToolExecutor,
  AnthropicCacheControl, AnthropicInputSchema, AnthropicToolCaller,
  GovernAnthropicConfig, GovernedAnthropicResult,
} from "./anthropic-types.js";

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernAnthropicConfig, toolNames: string[]): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "anthropic",
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

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernAnthropicConfig) {
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

export async function governAnthropicTools(
  governance: GovernanceInstance,
  tools: AnthropicToolExecutor[],
  config: GovernAnthropicConfig,
): Promise<GovernedAnthropicResult> {
  const toolNames = tools.map((t) => t.name);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const governedTools: AnthropicToolExecutor[] = tools.map((tool) => ({
    ...tool,
    execute: async (input: Record<string, unknown>) => {
      const decision = await enforce(tool.name, input);
      try {
        const output = await tool.execute(input);
        await audit(tool.name, "success");
        return output;
      } catch (error) {
        await audit(tool.name, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  }));

  async function handleToolUse(block: AnthropicToolUseBlock): Promise<AnthropicToolResultBlock> {
    const executor = toolMap.get(block.name);
    if (!executor) {
      return { type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true };
    }
    const input = (block.input ?? {}) as Record<string, unknown>;
    try {
      await enforce(block.name, input);
      const output = await executor.execute(input);
      await audit(block.name, "success");
      const content = typeof output === "string" ? output : JSON.stringify(output);
      return { type: "tool_result", tool_use_id: block.id, content };
    } catch (error) {
      if (error instanceof GovernanceBlockedError || error instanceof GovernanceApprovalRequiredError) {
        await audit(block.name, "failure", { reason: (error as GovernanceBlockedError).decision.reason });
        return { type: "tool_result", tool_use_id: block.id, content: `Blocked: ${(error as GovernanceBlockedError).decision.reason}`, is_error: true };
      }
      const msg = error instanceof Error ? error.message : String(error);
      await audit(block.name, "failure", { error: msg });
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }
  }

  return {
    tools: governedTools,
    handleToolUse,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}
