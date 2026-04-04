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

import type { ScoreDimension, DimensionResult } from "./types.js";
import type { AuditEvent } from "./storage.js";

/** Tuning parameters for behavioral scoring — configurable per org. */
export interface BehavioralConfig {
  /**
   * Block rate below this threshold is considered "clean" — no penalty.
   * Default: 0.05 (5%). A fintech org might set 0.01 (1%), a sandbox 0.2 (20%).
   */
  blockRateThreshold?: number;
  /**
   * How much to weight recent events vs old events (0-1).
   * 0 = all events weighted equally. 1 = only most recent events matter.
   * Default: 0.7 (recent-heavy).
   */
  recencyBias?: number;
  /**
   * Maximum number of recent events to consider for scoring.
   * Older events beyond this window are ignored.
   * Default: 200.
   */
  windowSize?: number;
}

/** Behavioral analysis input — raw audit events for one agent */
export interface BehavioralInput {
  events: AuditEvent[];
  /** Tools the agent declared at registration */
  declaredTools: string[];
  /** Org-level tuning (optional — sensible defaults applied) */
  config?: BehavioralConfig;
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

/**
 * Extract behavioral signals from audit events.
 * Uses recency-weighted block rate: recent events count more than old ones.
 */
export function computeSignals(input: BehavioralInput): BehavioralSignals {
  const { events, declaredTools, config } = input;
  const windowSize = config?.windowSize ?? 200;
  const recencyBias = config?.recencyBias ?? 0.7;

  if (events.length === 0) {
    return {
      totalEvents: 0, blockRate: 0, approvalRate: 0, injectionHits: 0,
      uniqueToolsObserved: [], undeclaredTools: [], eventFrequency: 0,
      lastActivityAt: null,
    };
  }

  // Window: only consider the most recent N events
  const sortedByTime = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const windowed = sortedByTime.slice(-windowSize);

  // Recency-weighted block rate: more recent events have higher weight.
  // With recencyBias=0.7, the most recent event has 1.0 weight,
  // the oldest has 0.3 weight. This makes the score responsive to
  // recent behavior changes without ignoring history entirely.
  let weightedBlocked = 0;
  let totalWeight = 0;
  for (let i = 0; i < windowed.length; i++) {
    const position = i / Math.max(1, windowed.length - 1); // 0 (oldest) to 1 (newest)
    const weight = (1 - recencyBias) + recencyBias * position;
    totalWeight += weight;
    if (windowed[i].outcome === "block") weightedBlocked += weight;
  }
  const blockRate = totalWeight > 0 ? weightedBlocked / totalWeight : 0;

  const approvals = windowed.filter((e) => e.outcome === "require_approval").length;
  const injections = windowed.filter((e) =>
    e.eventType === "injection_detected" ||
    (e.detail as Record<string, unknown>)?.outcome === "detected"
  ).length;

  // Tool diversity from event details
  const observedTools = new Set<string>();
  for (const e of windowed) {
    const detail = e.detail as Record<string, unknown> | undefined;
    if (detail?.tool && typeof detail.tool === "string") {
      observedTools.add(detail.tool);
    }
  }

  const declaredSet = new Set(declaredTools);
  const undeclared = [...observedTools].filter((t) => !declaredSet.has(t));

  // Event frequency (events per day)
  const first = new Date(windowed[0].createdAt).getTime();
  const last = new Date(windowed[windowed.length - 1].createdAt).getTime();
  const daySpan = Math.max(1, (last - first) / (1000 * 60 * 60 * 24));
  const frequency = windowed.length / daySpan;

  return {
    totalEvents: windowed.length,
    blockRate,
    approvalRate: windowed.length > 0 ? approvals / windowed.length : 0,
    injectionHits: injections,
    uniqueToolsObserved: [...observedTools],
    undeclaredTools: undeclared,
    eventFrequency: Math.round(frequency * 10) / 10,
    lastActivityAt: windowed[windowed.length - 1].createdAt,
  };
}

/** Compute per-dimension behavioral adjustments from audit signals. */
export function computeBehavioralAdjustments(
  input: BehavioralInput,
): BehavioralAssessment {
  const signals = computeSignals(input);
  const adjustments: BehavioralAdjustment[] = [];

  // Block rate threshold — below this is considered "clean enough"
  const threshold = input.config?.blockRateThreshold ?? 0.05;
  const isClean = signals.blockRate <= threshold;
  const isConcerning = signals.blockRate > threshold * 3; // 3x threshold = concerning

  // ── Identity ──────────────────────────────────────────────────
  let identityAdj = 0;
  if (signals.totalEvents > 0 && isClean) {
    identityAdj = signals.totalEvents > 10 ? 5 : 2;
  } else if (isConcerning) {
    identityAdj = -5;
  }
  adjustments.push({
    dimension: "identity",
    adjustment: clampAdj(identityAdj),
    evidence: { totalEvents: signals.totalEvents, hasActivity: signals.totalEvents > 0 },
  });

  // ── Permissions ───────────────────────────────────────────────
  let permAdj = 0;
  if (signals.undeclaredTools.length > 0) {
    permAdj -= Math.min(15, signals.undeclaredTools.length * 5);
  }
  if (signals.totalEvents > 5) {
    if (isClean) {
      permAdj += 5;
    } else {
      permAdj -= Math.min(15, Math.round(signals.blockRate * 30));
    }
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
  let obsAdj = 0;
  if (isClean && signals.totalEvents > 50) obsAdj += 10;
  else if (isClean && signals.totalEvents > 10) obsAdj += 5;
  else if (isConcerning) obsAdj -= 5;
  adjustments.push({
    dimension: "observability",
    adjustment: clampAdj(obsAdj),
    evidence: { eventFrequency: signals.eventFrequency, totalEvents: signals.totalEvents },
  });

  // ── Guardrails ────────────────────────────────────────────────
  let guardAdj = 0;
  if (signals.totalEvents > 5 && isClean && signals.injectionHits === 0) {
    guardAdj += 10;
  }
  if (!isClean) {
    guardAdj -= Math.min(15, Math.round(signals.blockRate * 30));
  }
  if (signals.injectionHits > 0) {
    guardAdj -= Math.min(10, signals.injectionHits * 3);
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
  let auditAdj = 0;
  if (isClean && signals.totalEvents > 20) auditAdj += 10;
  else if (isClean && signals.totalEvents > 5) auditAdj += 5;
  else if (isConcerning) auditAdj -= 5;
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
  let compAdj = 0;
  if (signals.totalEvents > 5 && isClean) {
    compAdj += 10;
  }
  if (!isClean) {
    compAdj -= Math.min(15, Math.round(signals.blockRate * 30));
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
  let lifeAdj = 0;
  if (signals.lastActivityAt) {
    const daysSince = (Date.now() - new Date(signals.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7 && isClean) lifeAdj += 5;
    else if (daysSince < 7 && isConcerning) lifeAdj -= 5;
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
