/**
 * governance-sdk Google Genkit Plugin
 *
 * Integrates governance enforcement into Genkit tool execution and flows.
 * Wraps tools with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governGenkitTools } from 'governance-sdk/plugins/genkit';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['file_delete', 'send_email'])],
 * });
 *
 * const { tools } = await governGenkitTools(gov, [searchTool, writeTool], {
 *   agentName: 'genkit-agent',
 *   owner: 'ai-team',
 * });
 *
 * // Use governed tools in your Genkit flow
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  GenkitTool, GenkitFlow,
  GovernGenkitConfig, GovernedGenkitToolsResult, GovernedGenkitFlowResult,
} from "./genkit-types.js";

// Re-export all types
export type {
  GenkitTool, GenkitFlow, GenkitMiddleware,
  GovernGenkitConfig, GovernedGenkitToolsResult, GovernedGenkitFlowResult,
} from "./genkit-types.js";

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

function buildRegistration(config: GovernGenkitConfig, toolNames: string[]): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "genkit",
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

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernGenkitConfig) {
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
  tool: GenkitTool,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
): GenkitTool {
  return {
    ...tool,
    call: async (input: unknown, options?: Record<string, unknown>): Promise<unknown> => {
      const inputRecord = typeof input === "object" && input !== null ? input as Record<string, unknown> : { input };
      const decision = await enforce(tool.name, inputRecord);
      if (decision.blocked) throw new GovernanceBlockedError(decision, tool.name);
      try {
        const output = await tool.call(input, options);
        await audit(tool.name, "success");
        return output;
      } catch (error) {
        await audit(tool.name, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}

// ─── Govern Genkit Tools ────────────────────────────────────

export async function governGenkitTools(
  governance: GovernanceInstance,
  tools: GenkitTool[],
  config: GovernGenkitConfig,
): Promise<GovernedGenkitToolsResult> {
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
    governance,
    enforce,
    audit,
  };
}

// ─── Govern Genkit Flow ─────────────────────────────────────

export async function governGenkitFlow(
  governance: GovernanceInstance,
  flow: GenkitFlow,
  config: GovernGenkitConfig,
): Promise<GovernedGenkitFlowResult> {
  const reg = buildRegistration(config, [flow.name]);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  const governedFlow: GenkitFlow = {
    ...flow,
    call: async (input: unknown): Promise<unknown> => {
      const inputRecord = typeof input === "object" && input !== null ? input as Record<string, unknown> : { input };
      const decision = await enforce(flow.name, inputRecord);

      if (decision.blocked) {
        throw new GovernanceBlockedError(decision, flow.name);
      }

      try {
        const output = await flow.call(input);
        await audit(flow.name, "success");
        return output;
      } catch (error) {
        await audit(flow.name, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };

  return {
    flow: governedFlow,
    agentId: result.id,
    score: result.score,
    level: result.level,
  };
}
