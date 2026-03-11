/**
 * Types for the Mastra Processor governance integration.
 *
 * Mirrors Mastra's Processor interface without requiring @mastra/core
 * as a dependency. Structurally compatible at runtime.
 *
 * Updated for Mastra v1.10+ (March 2026): ProcessOutputStepArgs
 * inherits from ProcessorMessageContext → ProcessorContext.
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
  requestContext?: Record<string, unknown>;
  /** Stream writer for emitting custom data-* chunks (optional, from ProcessorContext) */
  writer?: MastraStreamWriter;
  /** Abort signal from parent agent execution (optional, from ProcessorContext) */
  abortSignal?: AbortSignal;
}

/**
 * Mastra Processor interface — simplified for governance use.
 *
 * The real Mastra Processor has additional optional lifecycle methods:
 * processInput, processInputStep, processOutputStream, processOutputResult.
 * We only implement processOutputStep for governance enforcement.
 * Also supports __registerMastra (not mirrored here).
 */
export interface MastraProcessorInterface {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  processorIndex?: number;
  processOutputStep(args: ProcessOutputStepArgs): Promise<unknown> | unknown;
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
  metadata?: Record<string, unknown>;
  onBlocked?: (decision: EnforcementDecision, toolCall: MastraToolCallInfo) => void;
  onDecision?: (decision: EnforcementDecision, toolCall: MastraToolCallInfo) => void;
  actionMapper?: (toolName: string) => PolicyAction;
  sessionTokenTracker?: () => number;
  abortOnBlock?: boolean;
  abortMessage?: (decision: EnforcementDecision, toolCall: MastraToolCallInfo) => string;
  retryOnBlock?: boolean;
  maxRetries?: number;
}

// ─── Processor Stats ──────────────────────────────────────────

export interface ProcessorStats {
  totalProcessed: number;
  totalBlocked: number;
  totalAllowed: number;
  byTool: Record<string, { allowed: number; blocked: number }>;
  initializedAt: string;
}
