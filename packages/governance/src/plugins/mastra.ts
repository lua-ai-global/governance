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
import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePreprocess, enforcePostprocess } from "./pre-post-enforce.js";
import { enforcePostprocessStream } from "./pre-post-stream.js";
import type { StreamMode } from "./pre-post-stream.js";

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
  /** Called when a tool call triggers a warning (execution continues) */
  onWarn?: (decision: EnforcementDecision, toolName: string) => void;
  /** Called when output is masked */
  onMask?: (decision: EnforcementDecision, toolName: string, maskedText: string) => void;
  /** Called when a tool call requires human approval */
  onApprovalRequired?: (decision: EnforcementDecision, toolName: string) => void;
  /** Map tool call action types (default: "tool_call") */
  actionMapper?: (toolName: string) => PolicyAction;
  /** Track token usage per session */
  sessionTokenTracker?: () => number;
  /** Streaming post-scan mode for scanOutputStream (default: "buffered") */
  streamMode?: StreamMode;
  /** Sliding mode: chunks to hold back (default 2) */
  streamLookbackChunks?: number;
  /** Sliding mode: chars to hold back */
  streamLookbackChars?: number;
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
  /**
   * Pre-scan a user input string (e.g. the latest user message) BEFORE the
   * LLM runs. Throws GovernanceBlockedError on block. Returns the text to
   * use (possibly masked).
   */
  scanInput: (userText: string) => Promise<string>;
  /**
   * Post-scan a model output string AFTER generation, BEFORE returning to
   * the user. Throws GovernanceBlockedError on block. Returns the text to
   * emit (possibly masked).
   */
  scanOutput: (outputText: string) => Promise<string>;
  /**
   * Wrap an output token stream with post-scan enforcement. See
   * pre-post-stream.ts for mode semantics (buffered/sliding/per-chunk).
   */
  scanOutputStream: <ChunkT>(
    source: AsyncIterable<ChunkT>,
    options: {
      extractText: (chunk: ChunkT) => string;
      buildMaskedChunk?: (originalChunk: ChunkT, maskedText: string) => ChunkT;
    },
  ) => AsyncIterable<ChunkT>;
}

// Re-export error types from shared outcome handler
export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

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

    // Handle all outcomes — warn/mask pass through, block/approval throw
    handleOutcome(decision, toolName, config as OutcomeCallbacks);

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
      // Before: enforce policy — throws on block/approval_required
      await beforeToolCall(toolName, input as Record<string, unknown>);

      // Execute tool
      try {
        const output = await fn(input);

        // After: log success
        await afterToolCall(toolName, "success", {
          inputKeys: Object.keys(input),
        });

        return output;
      } catch (error) {
        // Don't log governance errors as tool failures
        if (error instanceof GovernanceBlockedError || error instanceof GovernanceApprovalRequiredError) {
          throw error;
        }
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

  // Pre/post parity with the mastra-processor adapter. These are explicit
  // calls the integrator makes — different from the processor's automatic
  // Mastra lifecycle hooks — suitable when you're wiring governance into
  // a custom runtime loop rather than plugging into inputProcessors[] /
  // outputProcessors[].
  const callbacks: OutcomeCallbacks = config as OutcomeCallbacks;

  async function scanInput(userText: string): Promise<string> {
    const pre = await enforcePreprocess(governance, userText, {
      agentId: result.id,
      agentName: config.agentName,
      agentLevel: result.level,
      metadata: config.metadata,
      sessionTokensUsed: config.sessionTokenTracker?.(),
      callbacks,
      toolName: "mastra.scanInput",
    });
    return pre.text;
  }

  async function scanOutput(outputText: string): Promise<string> {
    const post = await enforcePostprocess(governance, outputText, {
      agentId: result.id,
      agentName: config.agentName,
      agentLevel: result.level,
      metadata: config.metadata,
      sessionTokensUsed: config.sessionTokenTracker?.(),
      callbacks,
      toolName: "mastra.scanOutput",
    });
    return post.text;
  }

  function scanOutputStream<ChunkT>(
    source: AsyncIterable<ChunkT>,
    options: {
      extractText: (chunk: ChunkT) => string;
      buildMaskedChunk?: (originalChunk: ChunkT, maskedText: string) => ChunkT;
    },
  ): AsyncIterable<ChunkT> {
    return enforcePostprocessStream(governance, source, {
      agentId: result.id,
      agentName: config.agentName,
      agentLevel: result.level,
      metadata: config.metadata,
      sessionTokensUsed: config.sessionTokenTracker?.(),
      callbacks,
      toolName: "mastra.scanOutputStream",
      streamMode: config.streamMode,
      streamLookbackChunks: config.streamLookbackChunks,
      streamLookbackChars: config.streamLookbackChars,
      extractText: options.extractText,
      buildMaskedChunk: options.buildMaskedChunk,
    });
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
    scanInput,
    scanOutput,
    scanOutputStream,
  };
}
