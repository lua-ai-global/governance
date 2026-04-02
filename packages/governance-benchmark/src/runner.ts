/**
 * Agent Governance Benchmark — Runner
 *
 * Evaluates any detector and reports metrics broken down
 * by each taxonomy axis (vector, mechanism, objective, target).
 */

import type { BenchmarkSample, DetectorFn, BenchmarkResults } from "./types.js";

export type { BenchmarkSample, DetectorFn, BenchmarkResults } from "./types.js";

/** Run a detector against benchmark samples */
export async function runBenchmark(
  samples: BenchmarkSample[],
  detector: DetectorFn,
  detectorName: string = "unknown",
): Promise<BenchmarkResults> {
  const start = performance.now();

  let tp = 0, fp = 0, tn = 0, fn = 0;

  // Per-axis tracking for attacks
  const axisHits = (axis: string) => ({ tp: new Map<string, number>(), total: new Map<string, number>() });
  const byVector = axisHits("vector");
  const byMechanism = axisHits("mechanism");
  const byObjective = axisHits("objective");
  const byTarget = axisHits("target");

  // Per benign category FP tracking
  const benignFp = new Map<string, number>();
  const benignTotal = new Map<string, number>();

  const failures: BenchmarkResults["failures"] = [];

  for (const sample of samples) {
    const result = await detector(sample.text);
    const expected = sample.label === "injection";
    const got = result.detected;

    if (expected && got) {
      tp++;
      trackAxis(byVector, sample.vector, true);
      trackAxis(byMechanism, sample.mechanism, true);
      trackAxis(byObjective, sample.objective, true);
      trackAxis(byTarget, sample.target, true);
    } else if (!expected && !got) {
      tn++;
      if (sample.benignCategory) {
        benignTotal.set(sample.benignCategory, (benignTotal.get(sample.benignCategory) ?? 0) + 1);
      }
    } else if (!expected && got) {
      fp++;
      if (sample.benignCategory) {
        benignFp.set(sample.benignCategory, (benignFp.get(sample.benignCategory) ?? 0) + 1);
        benignTotal.set(sample.benignCategory, (benignTotal.get(sample.benignCategory) ?? 0) + 1);
      }
      failures.push({ id: sample.id, text: sample.text.slice(0, 100), expected: "benign", got: "injection", score: result.score, benignCategory: sample.benignCategory });
    } else {
      fn++;
      trackAxis(byVector, sample.vector, false);
      trackAxis(byMechanism, sample.mechanism, false);
      trackAxis(byObjective, sample.objective, false);
      trackAxis(byTarget, sample.target, false);
      failures.push({ id: sample.id, text: sample.text.slice(0, 100), expected: "injection", got: "benign", score: result.score, mechanism: sample.mechanism, objective: sample.objective });
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
  const totalBen = samples.filter((s) => s.label === "benign").length;
  const totalInj = samples.filter((s) => s.label === "injection").length;

  return {
    detector: detectorName,
    split: samples[0]?.split ?? "unknown",
    total: samples.length,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    accuracy: round((tp + tn) / samples.length),
    falsePositiveRate: round(totalBen > 0 ? fp / totalBen : 0),
    falseNegativeRate: round(totalInj > 0 ? fn / totalInj : 0),
    latencyMs: Math.round(performance.now() - start),
    recallByVector: computeAxisRecall(byVector),
    recallByMechanism: computeAxisRecall(byMechanism),
    recallByObjective: computeAxisRecall(byObjective),
    recallByTarget: computeAxisRecall(byTarget),
    fpByBenignCategory: computeFpRate(benignFp, benignTotal),
    failures,
  };
}

// ─── Axis Tracking Helpers ──────────────────────────────────

function trackAxis(axis: { tp: Map<string, number>; total: Map<string, number> }, value: string | undefined, detected: boolean): void {
  if (!value) return;
  axis.total.set(value, (axis.total.get(value) ?? 0) + 1);
  if (detected) axis.tp.set(value, (axis.tp.get(value) ?? 0) + 1);
}

function computeAxisRecall(axis: { tp: Map<string, number>; total: Map<string, number> }): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, total] of axis.total) {
    const hits = axis.tp.get(key) ?? 0;
    result[key] = round(total > 0 ? hits / total : 0);
  }
  return result;
}

function computeFpRate(fp: Map<string, number>, total: Map<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, t] of total) {
    const f = fp.get(key) ?? 0;
    result[key] = round(t > 0 ? f / t : 0);
  }
  return result;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── Formatting ─────────────────────────────────────────────

/** Format results as human-readable text */
export function formatResults(r: BenchmarkResults): string {
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════════════════════╗`);
  lines.push(`║  Agent Governance Benchmark — Results                ║`);
  lines.push(`╠══════════════════════════════════════════════════════╣`);
  lines.push(`║  Detector:    ${r.detector.padEnd(39)}║`);
  lines.push(`║  Split:       ${r.split.padEnd(39)}║`);
  lines.push(`║  Samples:     ${String(r.total).padEnd(39)}║`);
  lines.push(`╠══════════════════════════════════════════════════════╣`);
  lines.push(`║  Precision:   ${(r.precision * 100).toFixed(1).padEnd(6)}%                              ║`);
  lines.push(`║  Recall:      ${(r.recall * 100).toFixed(1).padEnd(6)}%                              ║`);
  lines.push(`║  F1 Score:    ${(r.f1 * 100).toFixed(1).padEnd(6)}%                              ║`);
  lines.push(`║  FP Rate:     ${(r.falsePositiveRate * 100).toFixed(1).padEnd(6)}%                              ║`);
  lines.push(`║  Latency:     ${(r.latencyMs + "ms").padEnd(39)}║`);
  lines.push(`╠══════════════════════════════════════════════════════╣`);

  const printAxis = (title: string, data: Record<string, number>) => {
    lines.push(`║  ${title}:${" ".repeat(42 - title.length)}║`);
    for (const [key, val] of Object.entries(data).sort((a, b) => b[1] - a[1])) {
      const short = key.length > 24 ? key.slice(0, 23) + "…" : key;
      lines.push(`║    ${short.padEnd(25)} ${(val * 100).toFixed(0).padStart(4)}% recall               ║`);
    }
  };

  printAxis("Recall by Mechanism", r.recallByMechanism);
  printAxis("Recall by Objective", r.recallByObjective);
  printAxis("Recall by Vector", r.recallByVector);

  if (Object.keys(r.fpByBenignCategory).length > 0) {
    lines.push(`║                                                      ║`);
    lines.push(`║  FP Rate by Benign Category:                         ║`);
    for (const [key, val] of Object.entries(r.fpByBenignCategory).sort((a, b) => b[1] - a[1])) {
      const short = key.length > 24 ? key.slice(0, 23) + "…" : key;
      lines.push(`║    ${short.padEnd(25)} ${(val * 100).toFixed(1).padStart(5)}% FP rate              ║`);
    }
  }

  lines.push(`╚══════════════════════════════════════════════════════╝`);
  return lines.join("\n");
}
