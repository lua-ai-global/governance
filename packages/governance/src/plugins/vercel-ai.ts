/**
 * @lua-ai-global/governance Vercel AI SDK Plugin
 *
 * Integrates governance enforcement into the Vercel AI SDK tool system.
 * Wraps tool execution with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from '@lua-ai-global/governance';
 * import { createGovernedTools } from '@lua-ai-global/governance/plugins/vercel-ai';
 * import { generateText, tool } from 'ai';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec', 'database_drop'])],
 * });
 *
 * const myTools = {
 *   webSearch: tool({ description: 'Search', parameters: z.object({ query: z.string() }), execute: async ({ query }) => ... }),
 *   crmUpdate: tool({ description: 'Update CRM', parameters: z.object({ id: z.string() }), execute: async ({ id }) => ... }),
 * };
 *
 * // Wrap all tools with governance
 * const { tools, middleware } = await createGovernedTools(gov, myTools, {
 *   agentName: 'sales-agent',
 *   owner: 'sales-team',
 *   framework: 'vercel-ai',
 * });
 *
 * // Use governed tools with generateText/streamText
 * const result = await generateText({ model, tools, prompt: '...' });
 * ```
 */

import type {
  GovernanceInstance,
  AuditEvent,
} from "../index";
import type {
  EnforcementDecision,
  PolicyAction,
} from "../policy";
import type { AgentRegistration, AgentFramework } from "../types";

// ─── Types ──────────────────────────────────────────────────────

/** Vercel AI SDK tool execution options (SDK 6+) */
export interface VercelToolExecutionOptions {
  toolCallId: string;
  messages: unknown[];
  abortSignal?: AbortSignal;
  /** Arbitrary context passthrough from generateText/streamText */
  experimental_context?: unknown;
}

/** Vercel AI SDK tool shape (SDK 6+ — uses inputSchema, not parameters) */
export interface VercelTool {
  description?: string;
  /** Human-readable display name (AI SDK 6+) */
  title?: string;
  /** @deprecated Use inputSchema (AI SDK 6 renamed parameters to inputSchema) */
  parameters?: unknown;
  /** Input schema — Zod or JSON Schema (required in SDK 6, optional here for wrapper flexibility) */
  inputSchema?: unknown;
  /** Output schema — Zod or JSON Schema (AI SDK 6+) */
  outputSchema?: unknown;
  /** Tool execution handler — options is required in SDK 6 */
  execute?: (input: unknown, options: VercelToolExecutionOptions) => Promise<unknown> | AsyncIterable<unknown> | unknown;
  /** Whether this tool requires human approval before execution */
  needsApproval?: boolean | ((input: unknown, options: { toolCallId: string; messages: unknown[]; experimental_context?: unknown }) => boolean | PromiseLike<boolean>);
  /** Enable strict schema validation (AI SDK 6+) */
  strict?: boolean;
  /** Tool type (AI SDK 6+) */
  type?: "function" | "dynamic" | "provider";
  /** Convert tool output to model-consumable content (replaces experimental_toToolResultContent) */
  toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;
  /** Callback when argument streaming begins */
  onInputStart?: (options: VercelToolExecutionOptions) => void | Promise<void>;
  /** Callback for argument streaming deltas */
  onInputDelta?: (options: { inputTextDelta: string } & VercelToolExecutionOptions) => void | Promise<void>;
  /** Callback when full input becomes available */
  onInputAvailable?: (options: { input: unknown } & VercelToolExecutionOptions) => void | Promise<void>;
  /** Example inputs for the tool */
  inputExamples?: Array<{ input: unknown }>;
  /** Provider-specific options */
  providerOptions?: Record<string, unknown>;
  /** Tool ID — for provider tools (format: `provider.toolName`) */
  id?: `${string}.${string}`;
  /** Tool name — for provider-defined tools */
  name?: string;
  /** Pre-set args — for provider-defined tools */
  args?: Record<string, unknown>;
}

export interface GovernedToolsConfig {
  agentName: string;
  owner: string;
  framework?: AgentFramework;
  description?: string;
  version?: string;
  channels?: string[];
  hasAuth?: boolean;
  hasGuardrails?: boolean;
  hasObservability?: boolean;
  permissions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  onBlocked?: (decision: EnforcementDecision, toolName: string) => void;
  onDecision?: (decision: EnforcementDecision, toolName: string) => void;
  actionMapper?: (toolName: string) => PolicyAction;
  sessionTokenTracker?: () => number;
}

export interface GovernedToolsResult<T> {
  tools: T;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

// ─── Blocked Error ──────────────────────────────────────────────

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

// ─── Create Governed Tools ──────────────────────────────────────

/**
 * Wrap Vercel AI SDK tools with governance enforcement.
 *
 * Returns new tool objects with the same shape but governed execute functions.
 * Each tool call is checked against policies before execution and logged to audit trail.
 */
export async function createGovernedTools<
  T extends Record<string, VercelTool>,
>(
  governance: GovernanceInstance,
  tools: T,
  config: GovernedToolsConfig,
): Promise<GovernedToolsResult<T>> {
  const registration: AgentRegistration = {
    name: config.agentName,
    framework: config.framework ?? "vercel-ai",
    owner: config.owner,
    description: config.description,
    version: config.version,
    channels: config.channels,
    tools: Object.keys(tools),
    hasAuth: config.hasAuth,
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: true,
    permissions: config.permissions,
    metadata: config.metadata,
  };

  const result = await governance.register(registration);

  async function enforce(
    toolName: string,
    input?: Record<string, unknown>,
  ): Promise<EnforcementDecision> {
    const action = config.actionMapper?.(toolName) ?? ("tool_call" as PolicyAction);

    const decision = await governance.enforce({
      agentId: result.id,
      agentName: config.agentName,
      agentLevel: result.level,
      action,
      tool: toolName,
      input,
      sessionTokensUsed: config.sessionTokenTracker?.(),
    });

    config.onDecision?.(decision, toolName);
    if (decision.blocked) {
      config.onBlocked?.(decision, toolName);
    }

    return decision;
  }

  async function audit(
    toolName: string,
    outcome: "success" | "failure",
    detail?: Record<string, unknown>,
  ): Promise<AuditEvent> {
    return governance.audit.log({
      agentId: result.id,
      eventType: "tool_call",
      outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: { tool: toolName, ...detail },
    });
  }

  // Wrap each tool's execute function
  const governed = {} as Record<string, VercelTool>;
  for (const [name, tool] of Object.entries(tools)) {
    governed[name] = {
      ...tool,
      execute: tool.execute
        ? async (input: unknown, options: VercelToolExecutionOptions) => {
            const decision = await enforce(name, (input ?? {}) as Record<string, unknown>);

            if (decision.blocked) {
              throw new GovernanceBlockedError(decision, name);
            }

            try {
              const output = await tool.execute!(input, options);
              await audit(name, "success");
              return output;
            } catch (error) {
              await audit(name, "failure", {
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          }
        : undefined,
    };
  }

  return {
    tools: governed as T,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}
