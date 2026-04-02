/**
 * governance-sdk Mastra Plugin
 *
 * Integrates governance enforcement into the Mastra agent lifecycle.
 * Wraps tool execution with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { Agent } from '@mastra/core';
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { createGovernanceMiddleware } from 'governance-sdk/plugins/mastra';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec', 'database_drop'])],
 * });
 *
 * const agent = new Agent({
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   instructions: '...',
 *   model: openai('gpt-4o'),
 *   tools: { webSearch, crmUpdate },
 * });
 *
 * // Wrap agent with governance enforcement
 * const middleware = createGovernanceMiddleware(gov, {
 *   agentName: 'my-agent',
 *   owner: 'sales-team',
 *   framework: 'mastra',
 * });
 * ```
 */

import type {
  GovernanceInstance,
  AuditEvent,
} from "../index";
import type {
  EnforcementContext,
  EnforcementDecision,
  PolicyAction,
} from "../policy";
import type { AgentRegistration, AgentFramework } from "../types";

// ─── Middleware Types ───────────────────────────────────────────

export interface GovernanceMiddlewareConfig {
  /** Agent name for registration */
  agentName: string;
  /** Agent owner (team/individual) */
  owner: string;
  /** Framework identifier */
  framework?: AgentFramework;
  /** Agent description */
  description?: string;
  /** Agent version */
  version?: string;
  /** Communication channels */
  channels?: string[];
  /** Whether agent has auth configured */
  hasAuth?: boolean;
  /** Whether agent has guardrails configured */
  hasGuardrails?: boolean;
  /** Whether agent has observability configured */
  hasObservability?: boolean;
  /** Whether agent has audit logging configured */
  hasAuditLog?: boolean;
  /** Custom permissions */
  permissions?: Record<string, unknown>;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Called when a tool call is blocked */
  onBlocked?: (decision: EnforcementDecision, toolName: string) => void;
  /** Called for every enforcement decision */
  onDecision?: (decision: EnforcementDecision, toolName: string) => void;
  /** Map tool call action types (default: "tool_call") */
  actionMapper?: (toolName: string) => PolicyAction;
  /** Track token usage per session */
  sessionTokenTracker?: () => number;
}

export interface GovernanceMiddleware {
  /** The registered agent ID */
  agentId: string;
  /** The agent's governance score */
  score: number;
  /** The agent's governance level */
  level: number;
  /** Enforce a policy check before a tool call */
  beforeToolCall: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  /** Log a tool call result to the audit trail */
  afterToolCall: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
  /** Get the governance instance */
  governance: GovernanceInstance;
  /** Wrap a tool function with governance enforcement */
  wrapTool: <TInput extends Record<string, unknown>, TOutput>(
    toolName: string,
    fn: (input: TInput) => Promise<TOutput>,
  ) => (input: TInput) => Promise<TOutput>;
  /** Wrap multiple tools at once */
  wrapTools: <T extends Record<string, (input: Record<string, unknown>) => Promise<unknown>>>(
    tools: T,
  ) => T;
}

// ─── Blocked Error ──────────────────────────────────────────────

export class GovernanceBlockedError extends Error {
  public readonly decision: EnforcementDecision;
  public readonly toolName: string;

  constructor(decision: EnforcementDecision, toolName: string) {
    super(`Governance blocked: ${decision.reason} (tool: ${toolName}, rule: ${decision.ruleId})`);
    this.name = "GovernanceBlockedError";
    this.decision = decision;
    this.toolName = toolName;
  }
}

// ─── Create Middleware ──────────────────────────────────────────

/**
 * Create governance middleware for a Mastra agent.
 *
 * Registers the agent, provides tool wrapping functions that enforce
 * policies before execution, and logs all actions to the audit trail.
 */
export async function createGovernanceMiddleware(
  governance: GovernanceInstance,
  config: GovernanceMiddlewareConfig,
): Promise<GovernanceMiddleware> {
  // Auto-register the agent
  const registration: AgentRegistration = {
    name: config.agentName,
    framework: config.framework ?? "mastra",
    owner: config.owner,
    description: config.description,
    version: config.version,
    channels: config.channels,
    hasAuth: config.hasAuth,
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: config.hasAuditLog ?? true, // governance provides audit
    permissions: config.permissions,
    metadata: config.metadata,
  };

  const result = await governance.register(registration);

  async function beforeToolCall(
    toolName: string,
    input?: Record<string, unknown>,
  ): Promise<EnforcementDecision> {
    const action = config.actionMapper
      ? config.actionMapper(toolName)
      : "tool_call" as PolicyAction;

    const ctx: EnforcementContext = {
      agentId: result.id,
      agentName: config.agentName,
      agentLevel: result.level,
      action,
      tool: toolName,
      input,
      sessionTokensUsed: config.sessionTokenTracker?.(),
    };

    const decision = await governance.enforce(ctx);

    config.onDecision?.(decision, toolName);

    if (decision.blocked) {
      config.onBlocked?.(decision, toolName);
    }

    return decision;
  }

  async function afterToolCall(
    toolName: string,
    outcome: "success" | "failure",
    detail?: Record<string, unknown>,
  ): Promise<AuditEvent> {
    return governance.audit.log({
      agentId: result.id,
      eventType: "tool_call",
      outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: {
        tool: toolName,
        ...detail,
      },
    });
  }

  function wrapTool<TInput extends Record<string, unknown>, TOutput>(
    toolName: string,
    fn: (input: TInput) => Promise<TOutput>,
  ): (input: TInput) => Promise<TOutput> {
    return async (input: TInput): Promise<TOutput> => {
      // Before: enforce policy
      const decision = await beforeToolCall(toolName, input as Record<string, unknown>);

      if (decision.blocked) {
        throw new GovernanceBlockedError(decision, toolName);
      }

      // Execute tool
      try {
        const output = await fn(input);

        // After: log success
        await afterToolCall(toolName, "success", {
          inputKeys: Object.keys(input),
        });

        return output;
      } catch (error) {
        // After: log failure
        await afterToolCall(toolName, "failure", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }

  function wrapTools<T extends Record<string, (input: Record<string, unknown>) => Promise<unknown>>>(
    tools: T,
  ): T {
    const wrapped = {} as Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
    for (const [name, fn] of Object.entries(tools)) {
      wrapped[name] = wrapTool(name, fn);
    }
    return wrapped as T;
  }

  return {
    agentId: result.id,
    score: result.score,
    level: result.level,
    beforeToolCall,
    afterToolCall,
    governance,
    wrapTool,
    wrapTools,
  };
}
