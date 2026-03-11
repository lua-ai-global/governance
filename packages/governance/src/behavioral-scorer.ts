/**
 * Behavioral Scoring — adjusts governance scores using observed audit data.
 *
 * Three signal categories:
 * 1. Enforcement signals — block rate, approval rate, rule triggers
 * 2. Activity signals — event volume, tool diversity, injection hits
 * 3. Drift signals — declared vs observed tool usage
 *
 * Returns per-dimension adjustments (-20 to +20) and evidence.
 */

import type { ScoreDimension, DimensionResult } from "./types";
import type { AuditEvent } from "./storage";

/** Behavioral analysis input — raw audit events for one agent */
export interface BehavioralInput {
  events: AuditEvent[];
  /** Tools the agent declared at registration */
  declaredTools: string[];
}

/** Per-dimension adjustment from behavioral analysis */
export interface BehavioralAdjustment {
  dimension: ScoreDimension;
  adjustment: number;
  evidence: Record<string, boolean | number | string>;
}

/** Full behavioral assessment result */
export interface BehavioralAssessment {
  adjustments: BehavioralAdjustment[];
  signals: BehavioralSignals;
}

/** Computed behavioral signals — useful for UI display */
export interface BehavioralSignals {
  totalEvents: number;
  blockRate: number;
  approvalRate: number;
  injectionHits: number;
  uniqueToolsObserved: string[];
  undeclaredTools: string[];
  eventFrequency: number; // events per day
  lastActivityAt: string | null;
}

const MAX_ADJUSTMENT = 20;
const MIN_ADJUSTMENT = -20;

function clampAdj(v: number): number {
  return Math.max(MIN_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, Math.round(v)));
}

/** Extract behavioral signals from raw audit events. */
export function computeSignals(input: BehavioralInput): BehavioralSignals {
  const { events, declaredTools } = input;

  if (events.length === 0) {
    return {
      totalEvents: 0, blockRate: 0, approvalRate: 0, injectionHits: 0,
      uniqueToolsObserved: [], undeclaredTools: [], eventFrequency: 0,
      lastActivityAt: null,
    };
  }

  const blocked = events.filter((e) => e.outcome === "blocked").length;
  const approvals = events.filter((e) => e.outcome === "require_approval").length;
  const injections = events.filter((e) =>
    e.eventType === "injection_detected" ||
    (e.detail as Record<string, unknown>)?.outcome === "detected"
  ).length;

  // Tool diversity from event details
  const observedTools = new Set<string>();
  for (const e of events) {
    const detail = e.detail as Record<string, unknown> | undefined;
    if (detail?.tool && typeof detail.tool === "string") {
      observedTools.add(detail.tool);
    }
  }

  const declaredSet = new Set(declaredTools);
  const undeclared = [...observedTools].filter((t) => !declaredSet.has(t));

  // Event frequency (events per day)
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = new Date(sorted[0].createdAt).getTime();
  const last = new Date(sorted[sorted.length - 1].createdAt).getTime();
  const daySpan = Math.max(1, (last - first) / (1000 * 60 * 60 * 24));
  const frequency = events.length / daySpan;

  return {
    totalEvents: events.length,
    blockRate: blocked / events.length,
    approvalRate: approvals / events.length,
    injectionHits: injections,
    uniqueToolsObserved: [...observedTools],
    undeclaredTools: undeclared,
    eventFrequency: Math.round(frequency * 10) / 10,
    lastActivityAt: sorted[sorted.length - 1].createdAt,
  };
}

/** Compute per-dimension behavioral adjustments from audit signals. */
export function computeBehavioralAdjustments(
  input: BehavioralInput,
): BehavioralAssessment {
  const signals = computeSignals(input);
  const adjustments: BehavioralAdjustment[] = [];

  // ── Identity ──────────────────────────────────────────────────
  // Active agents with audit trails prove identity
  const identityAdj = signals.totalEvents > 10 ? 5 : signals.totalEvents > 0 ? 2 : 0;
  adjustments.push({
    dimension: "identity",
    adjustment: clampAdj(identityAdj),
    evidence: { totalEvents: signals.totalEvents, hasActivity: signals.totalEvents > 0 },
  });

  // ── Permissions ───────────────────────────────────────────────
  // Undeclared tools = negative signal. Low block rate = good boundaries.
  let permAdj = 0;
  if (signals.undeclaredTools.length > 0) {
    permAdj -= Math.min(15, signals.undeclaredTools.length * 5);
  }
  if (signals.blockRate < 0.1 && signals.totalEvents > 5) {
    permAdj += 5; // agent stays within bounds
  }
  adjustments.push({
    dimension: "permissions",
    adjustment: clampAdj(permAdj),
    evidence: {
      undeclaredToolCount: signals.undeclaredTools.length,
      blockRate: Math.round(signals.blockRate * 100),
      observedTools: signals.uniqueToolsObserved.length,
    },
  });

  // ── Observability ─────────────────────────────────────────────
  // Regular audit events = agent is observable. High frequency = good.
  let obsAdj = 0;
  if (signals.totalEvents > 50) obsAdj += 10;
  else if (signals.totalEvents > 10) obsAdj += 5;
  adjustments.push({
    dimension: "observability",
    adjustment: clampAdj(obsAdj),
    evidence: { eventFrequency: signals.eventFrequency, totalEvents: signals.totalEvents },
  });

  // ── Guardrails ────────────────────────────────────────────────
  // High block rate = guardrails are catching things (good).
  // Injection hits = guardrails are needed and working.
  // Very high block rate (>50%) = agent is poorly configured (bad).
  let guardAdj = 0;
  if (signals.blockRate > 0 && signals.blockRate <= 0.3) {
    guardAdj += 10; // guardrails working, not overly restrictive
  } else if (signals.blockRate > 0.5) {
    guardAdj -= 10; // agent is constantly blocked — misconfigured
  }
  if (signals.injectionHits > 0 && signals.blockRate < 0.5) {
    guardAdj += 5; // injection guard is catching attacks
  }
  adjustments.push({
    dimension: "guardrails",
    adjustment: clampAdj(guardAdj),
    evidence: {
      blockRate: Math.round(signals.blockRate * 100),
      injectionHits: signals.injectionHits,
    },
  });

  // ── Auditability ──────────────────────────────────────────────
  // Presence of audit events proves audit trail works.
  let auditAdj = 0;
  if (signals.totalEvents > 20) auditAdj += 10;
  else if (signals.totalEvents > 5) auditAdj += 5;
  if (signals.lastActivityAt) {
    const daysSince = (Date.now() - new Date(signals.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 30) auditAdj -= 5; // stale — no recent audit data
  }
  adjustments.push({
    dimension: "auditability",
    adjustment: clampAdj(auditAdj),
    evidence: { totalEvents: signals.totalEvents, lastActivityAt: signals.lastActivityAt ?? "never" },
  });

  // ── Compliance ────────────────────────────────────────────────
  // Low block rate + active = compliant. Injection hits handled = good.
  let compAdj = 0;
  if (signals.totalEvents > 10 && signals.blockRate < 0.2) {
    compAdj += 10; // operating within policy
  }
  if (signals.blockRate > 0.4) {
    compAdj -= 10; // frequently violating policy
  }
  adjustments.push({
    dimension: "compliance",
    adjustment: clampAdj(compAdj),
    evidence: {
      blockRate: Math.round(signals.blockRate * 100),
      totalEvents: signals.totalEvents,
    },
  });

  // ── Lifecycle ─────────────────────────────────────────────────
  // Active agent = healthy lifecycle. Stale = concern.
  let lifeAdj = 0;
  if (signals.lastActivityAt) {
    const daysSince = (Date.now() - new Date(signals.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) lifeAdj += 5;
    else if (daysSince > 30) lifeAdj -= 10;
  }
  adjustments.push({
    dimension: "lifecycle",
    adjustment: clampAdj(lifeAdj),
    evidence: { lastActivityAt: signals.lastActivityAt ?? "never", eventFrequency: signals.eventFrequency },
  });

  return { adjustments, signals };
}

/** Apply behavioral adjustments to base dimension scores. */
export function applyBehavioralAdjustments(
  baseDimensions: DimensionResult[],
  adjustments: BehavioralAdjustment[],
): DimensionResult[] {
  const adjMap = new Map(adjustments.map((a) => [a.dimension, a]));

  return baseDimensions.map((dim) => {
    const adj = adjMap.get(dim.dimension);
    if (!adj || adj.adjustment === 0) return dim;

    const adjustedScore = Math.max(0, Math.min(100, dim.score + adj.adjustment));
    return {
      ...dim,
      score: adjustedScore,
      evidence: {
        ...dim.evidence,
        behavioralAdjustment: adj.adjustment,
        ...Object.fromEntries(
          Object.entries(adj.evidence).map(([k, v]) => [`behavioral_${k}`, v])
        ),
      },
    };
  });
}
