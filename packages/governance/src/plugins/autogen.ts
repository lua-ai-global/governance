/**
 * governance-sdk Microsoft AutoGen Plugin
 *
 * NOTE: AutoGen is in maintenance mode. Microsoft Agent Framework is the
 * successor. AG2 (ag2ai/ag2) is the community fork. These types approximate
 * AutoGen v0.7 Python shapes — no official TypeScript SDK exists.
 *
 * Integrates governance enforcement into AutoGen multi-agent tool execution.
 * Wraps tools with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governAutoGenAgent } from 'governance-sdk/plugins/autogen';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec', 'database_drop'])],
 * });
 *
 * const { agent } = await governAutoGenAgent(gov, {
 *   name: 'coding-agent',
 *   systemMessage: 'You write code.',
 *   tools: [execTool, fileTool],
 * }, {
 *   agentName: 'coding-agent',
 *   owner: 'dev-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  AutoGenTool, AutoGenAgent,
  GovernAutoGenConfig, GovernedAutoGenAgentResult, GovernedAutoGenToolsResult,
} from "./autogen-types.js";

// Re-export all types
export type {
  AutoGenTool, AutoGenToolLegacy, AutoGenAgent,
  AutoGenMessage, AutoGenMessageKind, AutoGenToolCall,
  AutoGenFunctionCall, AutoGenFunctionExecutionResult,
  AutoGenToolCallRequest, AutoGenToolCallExecution,
  GovernAutoGenConfig, GovernedAutoGenAgentResult, GovernedAutoGenToolsResult,
} from "./autogen-types.js";

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernAutoGenConfig, toolNames: string[], description?: string): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "autogen",
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

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernAutoGenConfig) {
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

function wrapTool(
  tool: AutoGenTool,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
): AutoGenTool {
  return {
    ...tool,
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
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
  };
}

// ─── Govern AutoGen Agent ───────────────────────────────────

export async function governAutoGenAgent(
  governance: GovernanceInstance,
  agent: AutoGenAgent,
  config: GovernAutoGenConfig,
): Promise<GovernedAutoGenAgentResult> {
  const toolNames = (agent.tools ?? []).map((t) => t.name);
  const reg = buildRegistration(config, toolNames, agent.description);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);
  const wrappedTools = (agent.tools ?? []).map((tool) => wrapTool(tool, enforce, audit));

  return {
    agent: { ...agent, tools: wrappedTools },
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}

// ─── Govern Tools Only ──────────────────────────────────────

export async function governAutoGenTools(
  governance: GovernanceInstance,
  tools: AutoGenTool[],
  config: GovernAutoGenConfig,
): Promise<GovernedAutoGenToolsResult> {
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
