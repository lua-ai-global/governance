/**
 * Types for the Mastra Processor governance integration.
 *
 * Mirrors Mastra's Processor interface without requiring @mastra/core
 * as a dependency. Structurally compatible at runtime.
 *
 * Updated for Mastra v1.10+ (March 2026): ProcessOutputStepArgs
 * inherits from ProcessorMessageContext → ProcessorContext.
 *
 * Updated for governance-sdk 0.8.0: adds ProcessInputArgs and
 * ProcessOutputResultArgs mirrors so the processor can implement
 * processInput() (preprocess on user messages) and processOutputResult()
 * (postprocess on the agent's final output) in addition to the existing
 * processOutputStep() (tool-call enforcement).
 */

import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Mastra Processor Types ────────────────────────────────────

export interface MastraToolCallInfo {
  toolName: string;
  args: unknown;
  toolCallId: string;
}

export interface MastraAbortOptions<TMetadata = unknown> {
  retry?: boolean;
  metadata?: TMetadata;
}

export interface GovernanceViolation {
  toolName: string;
  ruleId: string;
  reason: string;
  decision: EnforcementDecision;
}

export type MastraAbortFn = (
  reason?: string,
  options?: MastraAbortOptions<{ violations: GovernanceViolation[] }>,
) => never;

/** Mastra message shape (simplified — MastraDBMessage) */
export interface MastraMessage {
  role: string;
  content: unknown;
  id?: string;
}

/** Mastra stream writer for custom data chunks (ProcessorStreamWriter in SDK) */
export interface MastraStreamWriter {
  /** Emit a custom data chunk to the stream. Chunk type must start with 'data-' prefix. */
  custom<T extends { type: string }>(data: T): Promise<void>;
}

/**
 * Stage label passed to GovernanceProcessorConfig.metadataProvider.
 * Lets a single metadata-building function distinguish where it was called from.
 */
export type GovernanceStage = "preprocess" | "tool_call" | "postprocess";

/**
 * Resolved generation result passed to processOutputResult.
 * Mirror of Mastra's OutputResult.
 */
export interface MastraOutputResult {
  /** The accumulated text from all steps */
  text: string;
  /** Token usage (cumulative across all steps) */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    [key: string]: unknown;
  };
  /** Why the generation finished (e.g. 'stop', 'tool-calls', 'length') */
  finishReason?: string;
  /** All LLM step results */
  steps?: unknown[];
}

/**
 * Mastra ProcessOutputStepArgs — extends ProcessorMessageContext.
 *
 * Required fields come from the Mastra ProcessorContext and
 * ProcessorMessageContext base interfaces.
 */
export interface ProcessOutputStepArgs {
  /** Tool calls made in this step (optional — absent on non-tool steps) */
  toolCalls?: MastraToolCallInfo[];
  /** Text output from the model (optional — absent on tool-only steps) */
  text?: string;
  /** Step number (0-indexed) */
  stepNumber: number;
  /** Why the model stopped generating (optional) */
  finishReason?: string;
  /** Retry count — from ProcessorContext */
  retryCount: number;
  /** Abort function — from ProcessorContext */
  abort: MastraAbortFn;
  /** All messages including latest LLM response — from ProcessorMessageContext */
  messages: MastraMessage[];
  /** Message list instance for message management */
  messageList: unknown;
  /** System messages (instructions, memory, etc.) */
  systemMessages: MastraMessage[];
  /** Step results accumulated so far */
  steps: unknown[];
  /** Cross-step processor state */
  state: Record<string, unknown>;
  /** Per-request execution metadata — from ProcessorContext (optional) */
  requestContext?: unknown;
  /** Stream writer for emitting custom data-* chunks (optional, from ProcessorContext) */
  writer?: MastraStreamWriter;
  /** Abort signal from parent agent execution (optional, from ProcessorContext) */
  abortSignal?: AbortSignal;
}

/**
 * Mastra ProcessInputArgs — runs once BEFORE the LLM is called for the
 * first time. This is where preprocess governance fires (injection scanning,
 * input blocklists, input length, prompt-injection ML detection).
 *
 * Mirror of Mastra's ProcessInputArgs from @mastra/core/processors.
 */
export interface ProcessInputArgs {
  /** All messages being processed (including the latest user input) */
  messages: MastraMessage[];
  /** Message list instance for message management */
  messageList: unknown;
  /** All system messages (instructions, memory) — read/modify access */
  systemMessages: MastraMessage[];
  /** Per-processor state that persists across all method calls within this request */
  state: Record<string, unknown>;
  /** Retry count — from ProcessorContext */
  retryCount: number;
  /** Abort function — from ProcessorContext */
  abort: MastraAbortFn;
  /** Per-request execution metadata — from ProcessorContext (optional) */
  requestContext?: unknown;
  /** Stream writer for emitting custom data-* chunks (optional, from ProcessorContext) */
  writer?: MastraStreamWriter;
  /** Abort signal from parent agent execution (optional, from ProcessorContext) */
  abortSignal?: AbortSignal;
}

/**
 * Mastra ProcessOutputResultArgs — runs once AFTER the agent has finished
 * generating, with the resolved output result. This is where postprocess
 * governance fires (output filtering, PII redaction, sensitive-data masking).
 *
 * Mirror of Mastra's ProcessOutputResultArgs from @mastra/core/processors.
 */
export interface ProcessOutputResultArgs {
  /** All messages including the final assistant response */
  messages: MastraMessage[];
  /** Message list instance for message management */
  messageList: unknown;
  /** Per-processor state that persists across all method calls within this request */
  state: Record<string, unknown>;
  /** Retry count — from ProcessorContext */
  retryCount: number;
  /** Abort function — from ProcessorContext */
  abort: MastraAbortFn;
  /** Resolved generation result (final text, usage, finishReason, steps) */
  result: MastraOutputResult;
  /** Per-request execution metadata — from ProcessorContext (optional) */
  requestContext?: unknown;
  /** Stream writer for emitting custom data-* chunks (optional, from ProcessorContext) */
  writer?: MastraStreamWriter;
  /** Abort signal from parent agent execution (optional, from ProcessorContext) */
  abortSignal?: AbortSignal;
}

/**
 * Union of all argument shapes a `metadataProvider` callback may receive.
 * The `stage` parameter tells the callback which lifecycle method called it.
 */
export type GovernanceLifecycleArgs =
  | ProcessInputArgs
  | ProcessOutputStepArgs
  | ProcessOutputResultArgs;

/**
 * Mastra Processor interface — simplified for governance use.
 *
 * As of governance-sdk 0.8.0, the GovernanceProcessor implements three
 * Mastra lifecycle methods (processInput, processOutputStep, processOutputResult).
 * Mastra also supports processInputStep and processOutputStream — those are
 * not implemented yet (tracked for a future release).
 *
 * Also supports __registerMastra (not mirrored here).
 */
export interface MastraProcessorInterface {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  processorIndex?: number;
  /** Preprocess: runs once before the LLM is called */
  processInput?(args: ProcessInputArgs): Promise<unknown> | unknown;
  /** Per-step: runs after each LLM response, before tool execution */
  processOutputStep(args: ProcessOutputStepArgs): Promise<unknown> | unknown;
  /** Postprocess: runs once at the end, with the resolved output */
  processOutputResult?(args: ProcessOutputResultArgs): Promise<unknown> | unknown;
}

// ─── Processor Configuration ──────────────────────────────────

export interface GovernanceProcessorConfig {
  agentName: string;
  owner: string;
  framework?: AgentFramework;
  description?: string;
  version?: string;
  channels?: string[];
  hasAuth?: boolean;
  hasGuardrails?: boolean;
  hasObservability?: boolean;
  hasAuditLog?: boolean;
  permissions?: Record<string, unknown>;
  /**
   * Static metadata merged into every enforce call's `EnforcementContext.metadata`.
   * Per-call values from `metadataProvider` take precedence on key conflicts.
   */
  metadata?: Record<string, unknown>;

  // ─── Tool-call (processOutputStep) — existing ────────────────
  onBlocked?: (decision: EnforcementDecision, toolCall: MastraToolCallInfo) => void;
  onDecision?: (decision: EnforcementDecision, toolCall: MastraToolCallInfo) => void;
  actionMapper?: (toolName: string) => PolicyAction;
  sessionTokenTracker?: () => number;
  abortOnBlock?: boolean;
  abortMessage?: (decision: EnforcementDecision, toolCall: MastraToolCallInfo) => string;
  retryOnBlock?: boolean;
  maxRetries?: number;

  // ─── Per-call metadata enrichment — 0.8.0 ────────────────────
  /**
   * Per-call metadata enrichment. Called once per enforce invocation
   * (preprocess, tool call, postprocess) and the returned object is
   * merged into the `EnforcementContext.metadata` field that the SDK
   * sends to the policy engine and the cloud audit log.
   *
   * For Mastra integrators, the `args.requestContext` field is the
   * canonical place to read per-request data (userId, channel, threadId,
   * etc.) — Mastra's RequestContext is plumbed through every processor
   * lifecycle method.
   *
   * The promise return is supported because some integrators may need
   * to look up routing data from a service. Avoid anything slow here —
   * this runs synchronously inside the agent execution path.
   */
  metadataProvider?: (
    stage: GovernanceStage,
    args: GovernanceLifecycleArgs,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;

  // ─── Preprocess (processInput) — 0.8.0 ───────────────────────
  /**
   * Skip preprocess enforcement entirely. Default: false.
   * Useful for legacy migration paths or for replay flows where
   * governance has already approved the call out-of-band.
   */
  skipPreprocess?: boolean;
  /**
   * Fired when a preprocess rule blocks an inbound user message.
   * The second arg is the user message text that was scanned.
   */
  onPreprocessBlocked?: (decision: EnforcementDecision, message: string) => void;

  // ─── Postprocess (processOutputResult) — 0.8.0 ───────────────
  /**
   * Skip postprocess enforcement entirely. Default: false.
   */
  skipPostprocess?: boolean;
  /**
   * Fired when a postprocess rule blocks the agent's output.
   * The second arg is the agent's response text that was scanned.
   */
  onPostprocessBlocked?: (decision: EnforcementDecision, output: string) => void;

  // ─── Cross-stage callbacks — 0.8.0 ───────────────────────────
  /**
   * Fired when an enforcement decision returns `outcome: require_approval`
   * at any stage. The integrator typically uses this to surface the approval
   * payload (`decision.approval`, `decision.approvalId`) to its caller.
   */
  onApprovalRequired?: (decision: EnforcementDecision, stage: GovernanceStage) => void;
  /**
   * Fired when a postprocess rule returns `outcome: mask` and the SDK
   * computed a redacted version of the output. The processor mutates the
   * latest assistant message in place AFTER this callback fires.
   */
  onMask?: (decision: EnforcementDecision, original: string, masked: string) => void;
}

// ─── Processor Stats ──────────────────────────────────────────

export interface ProcessorStats {
  totalProcessed: number;
  totalBlocked: number;
  totalAllowed: number;
  byTool: Record<string, { allowed: number; blocked: number }>;
  initializedAt: string;
}
