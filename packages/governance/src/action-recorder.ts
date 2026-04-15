/**
 * governance-sdk — Action outcome recorder
 *
 * Thin helper that wraps an action function so its success/failure/
 * duration/output is automatically recorded via `gov.recordOutcome()`.
 * Use in framework adapters or user code to close the loop between
 * "enforce() approved this" and "here's what actually happened."
 *
 * When `gov.integrityChain` is configured, the recorded outcome is
 * HMAC-chained alongside every other SDK audit write — so the chain
 * covers the full decision → outcome cycle, not just decisions.
 *
 * @example
 * ```ts
 * import { runWithOutcome } from 'governance-sdk/action-recorder';
 *
 * const result = await runWithOutcome(gov, { agentId, tool: 'search' }, async () => {
 *   return searchApi.query(q);
 * });
 * // outcome event automatically recorded (success OR failure)
 * ```
 */

import type { GovernanceInstance, ActionOutcome } from "./index.js";

export interface RunWithOutcomeOptions {
  agentId: string;
  tool?: string;
  action?: string;
  policyRuleId?: string;
  /**
   * Optional transform for the successful result — lets you redact output
   * before it hits the audit log. Return `undefined` to skip output capture.
   */
  summarize?: (result: unknown) => unknown;
  /** Optional extra fields to include in the outcome detail. */
  detail?: Record<string, unknown>;
  /** Token count if this was an LLM call. */
  tokensUsed?: number;
}

/**
 * Run an async action and record its outcome to the governance audit chain.
 * Re-throws the underlying error after recording, so failures propagate
 * exactly as they would without this wrapper.
 */
export async function runWithOutcome<T>(
  governance: GovernanceInstance,
  options: RunWithOutcomeOptions,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await action();
    const durationMs = Date.now() - startedAt;
    const summary = options.summarize ? options.summarize(result) : result;
    const outcome: ActionOutcome = {
      agentId: options.agentId,
      tool: options.tool,
      action: options.action,
      success: true,
      durationMs,
      output: summary,
      policyRuleId: options.policyRuleId,
      tokensUsed: options.tokensUsed,
      detail: options.detail,
    };
    // Fire-and-forget: we don't want outcome logging failures to corrupt
    // the user's successful action. If integrityAudit.onFailure is set to
    // "block" the call will still throw inside recordOutcome — callers
    // concerned about that can await recordOutcome directly instead of
    // using this helper.
    governance.recordOutcome(outcome).catch(() => { /* swallowed */ });
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const outcome: ActionOutcome = {
      agentId: options.agentId,
      tool: options.tool,
      action: options.action,
      success: false,
      durationMs,
      error: message,
      policyRuleId: options.policyRuleId,
      tokensUsed: options.tokensUsed,
      detail: options.detail,
    };
    governance.recordOutcome(outcome).catch(() => { /* swallowed */ });
    throw err;
  }
}
