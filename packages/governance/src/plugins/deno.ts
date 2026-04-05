/**
 * governance-sdk Deno AI Plugin
 *
 * Integrates governance enforcement into Deno-native AI agent patterns.
 * Wraps tools with policy checks and integrates with Deno's permission model.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governDenoAgent } from 'governance-sdk/plugins/deno';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['file_delete', 'shell_exec'])],
 * });
 *
 * const { agent } = await governDenoAgent(gov, {
 *   name: 'deno-agent',
 *   tools: [readFileTool, writeFileTool],
 *   permissions: [{ name: 'read', path: '/data' }],
 * }, {
 *   agentName: 'deno-agent',
 *   owner: 'platform-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  DenoTool, DenoAgent, DenoPermissionDescriptor,
  GovernDenoConfig, GovernedDenoAgentResult, GovernedDenoToolsResult,
} from "./deno-types.js";

// Re-export all types
export type {
  DenoTool, DenoAgent, DenoPermissionDescriptor,
  GovernDenoConfig, GovernedDenoAgentResult, GovernedDenoToolsResult,
} from "./deno-types.js";

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernDenoConfig, toolNames: string[], permissions?: DenoPermissionDescriptor[]): AgentRegistration {
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
    permissions: {
      ...config.permissions,
      denoPermissions: permissions?.map((p) => p.name),
    },
    metadata: { ...config.metadata, runtime: "deno" },
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernDenoConfig) {
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
  tool: DenoTool,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
): DenoTool {
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

// ─── Govern Deno Agent ──────────────────────────────────────

export async function governDenoAgent(
  governance: GovernanceInstance,
  agent: DenoAgent,
  config: GovernDenoConfig,
): Promise<GovernedDenoAgentResult> {
  const toolNames = agent.tools.map((t) => t.name);
  const reg = buildRegistration(config, toolNames, agent.permissions);
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

// ─── Govern Deno Tools ──────────────────────────────────────

export async function governDenoTools(
  governance: GovernanceInstance,
  tools: DenoTool[],
  config: GovernDenoConfig,
): Promise<GovernedDenoToolsResult> {
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
