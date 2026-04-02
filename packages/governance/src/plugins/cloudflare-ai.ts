/**
 * governance-sdk Cloudflare Workers AI Plugin
 *
 * Integrates governance enforcement into Cloudflare Workers AI tool execution.
 * Wraps tool executors with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governCloudflareTools } from 'governance-sdk/plugins/cloudflare-ai';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec', 'file_delete'])],
 * });
 *
 * const { tools } = await governCloudflareTools(gov, myToolExecutors, {
 *   agentName: 'edge-agent',
 *   owner: 'platform-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  CloudflareToolExecutor,
  GovernCloudflareAIConfig, GovernedCloudflareAIResult,
} from "./cloudflare-ai-types.js";

// Re-export all types
export type {
  CloudflareToolCall, CloudflareToolDefinition, CloudflareMessage,
  CloudflareToolCallMessage, CloudflareAIGatewayRequest, CloudflareToolExecutor,
  GovernCloudflareAIConfig, GovernedCloudflareAIResult,
} from "./cloudflare-ai-types.js";

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

function buildRegistration(config: GovernCloudflareAIConfig, toolNames: string[]): AgentRegistration {
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
    metadata: { ...config.metadata, runtime: "cloudflare-workers" },
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernCloudflareAIConfig) {
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
  tool: CloudflareToolExecutor,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
): CloudflareToolExecutor {
  return {
    ...tool,
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
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
  };
}

// ─── Govern Cloudflare Tools ────────────────────────────────

export async function governCloudflareTools(
  governance: GovernanceInstance,
  tools: CloudflareToolExecutor[],
  config: GovernCloudflareAIConfig,
): Promise<GovernedCloudflareAIResult> {
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
