/**
 * Shared pre/post enforcement helpers for framework adapters.
 *
 * Every adapter that can intercept LLM input or output should route through
 * `enforcePreprocess` / `enforcePostprocess` here so outcome handling,
 * callbacks, masking, and errors stay consistent across frameworks.
 *
 * These helpers are thin wrappers around `gov.enforcePreprocess` /
 * `gov.enforcePostprocess` plus the shared `handleOutcome`. They return
 * `{ decision, text }` where:
 *
 *   - allow / warn  → text is the original input/output, unchanged
 *   - mask          → text is the masked version (callback fired)
 *   - block         → throws GovernanceBlockedError (never returns)
 *   - require_approval → throws GovernanceApprovalRequiredError
 *
 * This means the caller can just use `text` downstream without branching on
 * outcome — the flow is "call this, use the returned text, done".
 */

import type { GovernanceInstance } from "../index";
import type {
  EnforcementContext,
  EnforcementDecision,
  PolicyAction,
} from "../policy";
import { handleOutcome } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Sentinel tool names ──────────────────────────────────────
// Used so audit/outcome callbacks can distinguish lifecycle stage
// from real tool calls. Matches mastra-processor's convention.
export const PREPROCESS_TOOL_NAME = "__preprocess__";
export const POSTPROCESS_TOOL_NAME = "__postprocess__";

// ─── Types ────────────────────────────────────────────────────

/** Agent identity needed to build an EnforcementContext. */
export interface PrePostAgentIdentity {
  agentId: string;
  agentName?: string;
  agentLevel?: number;
}

/** Options passed to every pre/post call. */
export interface PrePostEnforceOptions extends PrePostAgentIdentity {
  /** Defaults to "message_send". */
  action?: PolicyAction;
  /** Per-call metadata, merged into the EnforcementContext. */
  metadata?: Record<string, unknown>;
  /** Session tokens consumed so far — used by token-budget rules. */
  sessionTokensUsed?: number;
  /** Outcome callbacks (onBlocked, onMask, ...). */
  callbacks?: OutcomeCallbacks;
  /** Override the sentinel tool name used for callbacks/logging. */
  toolName?: string;
}

/** Result shape shared by pre/post helpers. */
export interface PrePostResult {
  /** The raw enforcement decision (for inspection / audit). */
  decision: EnforcementDecision;
  /**
   * The text the adapter should use downstream:
   *   - allow / warn → the original input (pre) or output (post)
   *   - mask         → the masked version
   * On block / require_approval we throw before returning.
   */
  text: string;
}

// ─── enforcePreprocess ────────────────────────────────────────

/**
 * Run preprocess-stage governance against a user input string.
 *
 * Call BEFORE the LLM sees the prompt. Throws on block/approval; otherwise
 * returns the (possibly masked) text to use as input.
 */
export async function enforcePreprocess(
  governance: GovernanceInstance,
  inputText: string,
  options: PrePostEnforceOptions,
): Promise<PrePostResult> {
  const ctx: EnforcementContext = {
    agentId: options.agentId,
    agentName: options.agentName,
    agentLevel: options.agentLevel,
    action: options.action ?? "message_send",
    input: { message: inputText },
    sessionTokensUsed: options.sessionTokensUsed,
    ...(options.metadata && Object.keys(options.metadata).length > 0
      ? { metadata: options.metadata }
      : {}),
  };

  const decision = await governance.enforcePreprocess(ctx);
  const toolName = options.toolName ?? PREPROCESS_TOOL_NAME;

  // handleOutcome throws on block / require_approval. On warn it's a no-op.
  // On mask it fires the onMask callback; we substitute maskedText below.
  handleOutcome(decision, toolName, options.callbacks ?? {});

  const text =
    decision.outcome === "mask" && decision.maskedText
      ? decision.maskedText
      : inputText;

  return { decision, text };
}

// ─── enforcePostprocess ───────────────────────────────────────

/**
 * Run postprocess-stage governance against a model output string.
 *
 * Call AFTER the model has generated text. Throws on block/approval;
 * otherwise returns the (possibly masked) output to surface to the user.
 */
export async function enforcePostprocess(
  governance: GovernanceInstance,
  outputText: string,
  options: PrePostEnforceOptions & {
    /** Used for output token-budget rules. */
    outputTokenCount?: number;
    /** Used for latency/perf rules. */
    executionDurationMs?: number;
  },
): Promise<PrePostResult> {
  const ctx: EnforcementContext = {
    agentId: options.agentId,
    agentName: options.agentName,
    agentLevel: options.agentLevel,
    action: options.action ?? "message_send",
    input: { message: outputText },
    outputText,
    outputTokenCount: options.outputTokenCount,
    executionDurationMs: options.executionDurationMs,
    sessionTokensUsed: options.sessionTokensUsed,
    ...(options.metadata && Object.keys(options.metadata).length > 0
      ? { metadata: options.metadata }
      : {}),
  };

  const decision = await governance.enforcePostprocess(ctx);
  const toolName = options.toolName ?? POSTPROCESS_TOOL_NAME;

  handleOutcome(decision, toolName, options.callbacks ?? {});

  const text =
    decision.outcome === "mask" && decision.maskedText
      ? decision.maskedText
      : outputText;

  return { decision, text };
}
