/**
 * Shared outcome handler for all framework adapters.
 *
 * Handles all 5 enforcement outcomes (allow, block, warn, require_approval, mask)
 * so individual adapters don't need to duplicate this logic.
 */

import type { EnforcementDecision } from "../policy.js";

// ─── Error Types ──────────────────────────────────────────────

/** Thrown when a tool call is blocked by governance policy. */
export class GovernanceBlockedError extends Error {
  public readonly decision: EnforcementDecision;
  public readonly toolName: string;

  constructor(decision: EnforcementDecision, toolName: string) {
    super(`Governance blocked ${toolName}: ${decision.reason}`);
    this.name = "GovernanceBlockedError";
    this.decision = decision;
    this.toolName = toolName;
  }
}

/** Thrown when a tool call requires human approval before proceeding. */
export class GovernanceApprovalRequiredError extends Error {
  public readonly decision: EnforcementDecision;
  public readonly toolName: string;
  public readonly approvalId: string;
  public readonly pollUrl: string;

  constructor(decision: EnforcementDecision, toolName: string) {
    super(`Governance requires approval for ${toolName}: ${decision.reason}`);
    this.name = "GovernanceApprovalRequiredError";
    this.decision = decision;
    this.toolName = toolName;
    this.approvalId = decision.approvalId ?? "";
    this.pollUrl = decision.approval?.pollUrl ?? "";
  }
}

// ─── Outcome Callbacks ────────────────────────────────────────

export interface OutcomeCallbacks {
  onDecision?: (decision: EnforcementDecision, toolName: string) => void;
  onBlocked?: (decision: EnforcementDecision, toolName: string) => void;
  onWarn?: (decision: EnforcementDecision, toolName: string) => void;
  onMask?: (decision: EnforcementDecision, toolName: string, maskedText: string) => void;
  onApprovalRequired?: (decision: EnforcementDecision, toolName: string) => void;
}

// ─── Outcome Handler ──────────────────────────────────────────

/**
 * Handle an enforcement decision with proper outcome-specific behavior.
 *
 * - `allow`: No action, returns decision.
 * - `warn`: Calls onWarn callback, returns decision (does NOT block).
 * - `mask`: Calls onMask callback with maskedText, returns decision.
 * - `require_approval`: Throws GovernanceApprovalRequiredError.
 * - `block`: Throws GovernanceBlockedError.
 *
 * Always calls onDecision for every outcome.
 */
export function handleOutcome(
  decision: EnforcementDecision,
  toolName: string,
  callbacks: OutcomeCallbacks,
): EnforcementDecision {
  callbacks.onDecision?.(decision, toolName);

  switch (decision.outcome) {
    case "warn":
      callbacks.onWarn?.(decision, toolName);
      return decision;

    case "mask":
      if (decision.maskedText) {
        callbacks.onMask?.(decision, toolName, decision.maskedText);
      }
      return decision;

    case "require_approval":
      callbacks.onApprovalRequired?.(decision, toolName);
      throw new GovernanceApprovalRequiredError(decision, toolName);

    case "block":
      callbacks.onBlocked?.(decision, toolName);
      throw new GovernanceBlockedError(decision, toolName);

    default:
      // "allow" or unknown — pass through
      if (decision.blocked) {
        callbacks.onBlocked?.(decision, toolName);
        throw new GovernanceBlockedError(decision, toolName);
      }
      return decision;
  }
}
