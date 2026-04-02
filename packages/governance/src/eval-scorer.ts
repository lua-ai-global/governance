/**
 * @lua-ai-global/governance — Eval Scorer
 *
 * Maps eval metric results to governance dimension adjustments.
 * Works alongside behavioral-scorer.ts — eval signals are direct quality
 * measurements while behavioral signals are proxy indicators.
 *
 * The adjustment range is -20 to +20 per dimension, same as behavioral.
 *
 * Metric → Dimension mapping:
 *   tool_correctness     → permissions, guardrails
 *   output_faithfulness  → compliance
 *   task_completion      → lifecycle
 *   safety_compliance    → guardrails
 *   instruction_following→ compliance
 *   red_team_resistance  → guardrails, compliance
 *
 * @example
 * ```ts
 * import { computeEvalAdjustments, applyEvalAdjustments } from '@lua-ai-global/governance/eval-scorer';
 *
 * const adjustments = computeEvalAdjustments({ results: recentEvals });
 * const adjusted = applyEvalAdjustments(baseDimensions, adjustments);
 * ```
 */

import type { ScoreDimension, DimensionResult } from "./types.js";
import type { EvalResult } from "./eval-types.js";

// ─── Types ───────────────────────────────────────────────────

export interface EvalScorerInput {
  /** Recent eval results for one agent */
  results: EvalResult[];
}

export interface EvalAdjustment {
  dimension: ScoreDimension;
  adjustment: number;
  evidence: Record<string, boolean | number | string>;
}

export interface EvalAssessment {
  adjustments: EvalAdjustment[];
  /** Aggregate eval quality score (0-1) across all metrics */
  overallQuality: number;
  /** Number of eval results analyzed */
  resultsAnalyzed: number;
}

// ─── Metric → Dimension Mapping ────────────────────────────────

interface DimensionMapping {
  dimension: ScoreDimension;
  /** How much this metric affects this dimension (0-1) */
  influence: number;
}

const METRIC_DIMENSION_MAP: Record<string, DimensionMapping[]> = {
  tool_correctness:      [{ dimension: "permissions", influence: 0.7 }, { dimension: "guardrails", influence: 0.3 }],
  output_faithfulness:   [{ dimension: "compliance", influence: 1.0 }],
  task_completion:       [{ dimension: "lifecycle", influence: 0.6 }, { dimension: "observability", influence: 0.4 }],
  safety_compliance:     [{ dimension: "guardrails", influence: 1.0 }],
  instruction_following: [{ dimension: "compliance", influence: 0.6 }, { dimension: "permissions", influence: 0.4 }],
  red_team_resistance:   [{ dimension: "guardrails", influence: 0.7 }, { dimension: "compliance", influence: 0.3 }],
};

// ─── Constants ─────────────────────────────────────────────────

const MAX_ADJUSTMENT = 20;
const MIN_ADJUSTMENT = -20;

/**
 * Threshold below which scores penalize. Above which they reward.
 * 0.7 = "good enough". Below 0.7 → negative adjustment. Above → positive.
 */
const NEUTRAL_THRESHOLD = 0.7;

/** Maximum adjustment per metric (before influence weighting) */
const MAX_METRIC_IMPACT = 15;

// ─── Implementation ────────────────────────────────────────────

function clamp(v: number): number {
  return Math.max(MIN_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, Math.round(v)));
}

/**
 * Compute governance dimension adjustments from eval results.
 *
 * Aggregates all metrics across recent eval results, maps them
 * to governance dimensions, and produces per-dimension adjustments.
 */
export function computeEvalAdjustments(input: EvalScorerInput): EvalAssessment {
  const { results } = input;

  if (results.length === 0) {
    return { adjustments: [], overallQuality: 0, resultsAnalyzed: 0 };
  }

  // Aggregate metric scores: metric name → all scores
  const metricScores = new Map<string, number[]>();

  for (const result of results) {
    for (const metric of result.metrics) {
      if (!metricScores.has(metric.name)) metricScores.set(metric.name, []);
      metricScores.get(metric.name)!.push(metric.score);
    }
  }

  // Compute average per metric
  const metricAverages = new Map<string, number>();
  for (const [name, scores] of metricScores) {
    metricAverages.set(name, scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  // Accumulate per-dimension adjustments
  const dimensionAccum = new Map<ScoreDimension, { total: number; count: number }>();

  for (const [metricName, avgScore] of metricAverages) {
    const mappings = METRIC_DIMENSION_MAP[metricName];
    if (!mappings) continue; // custom metric with no mapping — skip

    // Convert score to adjustment: below threshold → negative, above → positive
    // Symmetric scaling: 0.0 → -MAX, 0.7 → 0, 1.0 → +MAX
    let rawAdjustment: number;
    if (avgScore >= NEUTRAL_THRESHOLD) {
      rawAdjustment = ((avgScore - NEUTRAL_THRESHOLD) / (1 - NEUTRAL_THRESHOLD)) * MAX_METRIC_IMPACT;
    } else {
      rawAdjustment = ((avgScore - NEUTRAL_THRESHOLD) / NEUTRAL_THRESHOLD) * MAX_METRIC_IMPACT;
    }

    for (const mapping of mappings) {
      const weighted = rawAdjustment * mapping.influence;
      if (!dimensionAccum.has(mapping.dimension)) {
        dimensionAccum.set(mapping.dimension, { total: 0, count: 0 });
      }
      const accum = dimensionAccum.get(mapping.dimension)!;
      accum.total += weighted;
      accum.count++;
    }
  }

  // Build adjustments
  const adjustments: EvalAdjustment[] = [];
  for (const [dimension, accum] of dimensionAccum) {
    const avgAdjustment = accum.count > 0 ? accum.total / accum.count : 0;

    const evidence: Record<string, boolean | number | string> = {
      evalResultsCount: results.length,
      metricsEvaluated: accum.count,
    };

    // Add per-metric scores to evidence
    for (const [metricName, avg] of metricAverages) {
      const mappings = METRIC_DIMENSION_MAP[metricName];
      if (mappings?.some((m) => m.dimension === dimension)) {
        evidence[`eval_${metricName}`] = Math.round(avg * 100);
      }
    }

    adjustments.push({
      dimension,
      adjustment: clamp(avgAdjustment),
      evidence,
    });
  }

  // Overall quality: average of all metric averages
  const allAverages = [...metricAverages.values()];
  const overallQuality = allAverages.length > 0
    ? Math.round((allAverages.reduce((a, b) => a + b, 0) / allAverages.length) * 1000) / 1000
    : 0;

  return { adjustments, overallQuality, resultsAnalyzed: results.length };
}

/**
 * Apply eval adjustments to base dimension scores.
 * Same pattern as applyBehavioralAdjustments.
 */
export function applyEvalAdjustments(
  baseDimensions: DimensionResult[],
  adjustments: EvalAdjustment[],
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
        evalAdjustment: adj.adjustment,
        ...Object.fromEntries(
          Object.entries(adj.evidence).map(([k, v]) => [`eval_${k}`, v]),
        ),
      },
    };
  });
}
