/**
 * governance-sdk CrewAI Plugin
 *
 * Integrates governance enforcement into CrewAI agent tool execution.
 * Wraps tools with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governCrewAIAgent } from 'governance-sdk/plugins/crewai';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec'])],
 * });
 *
 * const { agent } = await governCrewAIAgent(gov, {
 *   role: 'researcher',
 *   goal: 'Find information',
 *   tools: [webSearchTool, fileReadTool],
 * }, {
 *   agentName: 'researcher',
 *   owner: 'research-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  CrewAITool, CrewAIAgent,
  GovernCrewAIConfig, GovernedCrewAIAgentResult, GovernedCrewAIToolsResult,
} from "./crewai-types.js";

// Re-export all types
export type {
  CrewAITool, CrewAIAgent, CrewAITask,
  GovernCrewAIConfig, GovernedCrewAIAgentResult, GovernedCrewAIToolsResult,
} from "./crewai-types.js";

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernCrewAIConfig, toolNames: string[], description?: string): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "crewai",
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

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernCrewAIConfig) {
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
  tool: CrewAITool,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
): CrewAITool {
  return {
    ...tool,
    execute: async (input: Record<string, unknown>): Promise<unknown> => {
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
  };
}

// ─── Govern CrewAI Agent ────────────────────────────────────

export async function governCrewAIAgent(
  governance: GovernanceInstance,
  agent: CrewAIAgent,
  config: GovernCrewAIConfig,
): Promise<GovernedCrewAIAgentResult> {
  const toolNames = (agent.tools ?? []).map((t) => t.name);
  const reg = buildRegistration(config, toolNames, agent.goal);
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

export async function governCrewAITools(
  governance: GovernanceInstance,
  tools: CrewAITool[],
  config: GovernCrewAIConfig,
): Promise<GovernedCrewAIToolsResult> {
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
