/**
 * governance-sdk Composio Plugin
 *
 * Integrates governance enforcement into Composio tool execution.
 * Wraps tools with before-action policy checks and audit logging.
 *
 * Updated for @composio/core v0.6+ (Actions→Tools, Apps→Toolkits).
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governComposioTools } from 'governance-sdk/plugins/composio';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['GMAIL_SEND_EMAIL'])],
 * });
 *
 * const { tools } = await governComposioTools(gov, myTools, {
 *   agentName: 'composio-agent',
 *   owner: 'integration-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  ComposioTool,
  GovernComposioConfig, GovernedComposioResult,
} from "./composio-types.js";

// Re-export all types (new + legacy aliases)
export type {
  ComposioTool, ComposioToolResult, ComposioConnectedAccount, ComposioTrigger,
  ComposioAction, ComposioActionResult, ComposioConnection,
  GovernComposioConfig, GovernedComposioResult,
} from "./composio-types.js";

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

function buildRegistration(config: GovernComposioConfig, toolNames: string[]): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "composio",
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

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernComposioConfig) {
  return async (toolName: string, input?: Record<string, unknown>): Promise<EnforcementDecision> => {
    const toolkitMapper = config.toolkitActionMapper ?? config.appActionMapper;
    const action = toolkitMapper?.(toolName.split("_")[0] ?? toolName)
      ?? config.actionMapper?.(toolName)
      ?? ("tool_call" as PolicyAction);
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

/** Govern Composio tools (v0.6+ API) */
export async function governComposioTools(
  governance: GovernanceInstance,
  tools: ComposioTool[],
  config: GovernComposioConfig,
): Promise<GovernedComposioResult> {
  const toolNames = tools.map((t) => t.name);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  const governedTools: ComposioTool[] = tools.map((tool) => ({
    ...tool,
    execute: async (params: Record<string, unknown>) => {
      const decision = await enforce(tool.name, params);
      if (decision.blocked) throw new GovernanceBlockedError(decision, tool.name);
      try {
        const output = await tool.execute!(params);
        await audit(tool.name, "success", { toolkitSlug: tool.toolkitSlug });
        return output;
      } catch (error) {
        await audit(tool.name, "failure", {
          toolkitSlug: tool.toolkitSlug,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  }));

  return {
    tools: governedTools,
    actions: governedTools, // backward compat
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}

/** @deprecated Use governComposioTools instead */
export const governComposioActions = governComposioTools;
