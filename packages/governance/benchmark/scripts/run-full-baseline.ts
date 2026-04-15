/**
 * Run the shipped `detectInjection()` regex detector against the full
 * Lua Injection Benchmark v1 dataset (6,931 samples). Emits a baseline
 * metrics report committed alongside the dataset so users can audit what
 * the default detector actually achieves.
 *
 * Usage:
 *   cd packages/governance && npx tsx benchmark/scripts/run-full-baseline.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectInjection } from "../../src/injection-detect.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data", "lua-injection-benchmark-v1.jsonl");
const OUT = join(__dirname, "..", "data", "lua-injection-benchmark-v1-regex-baseline.json");

type Sample = {
  id: string;
  text: string;
  label: "injection" | "benign";
  category?: string;
  source: string;
};

const samples = readFileSync(DATA, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Sample);

let tp = 0,
  tn = 0,
  fp = 0,
  fn = 0;
const bySource: Record<string, { tp: number; tn: number; fp: number; fn: number }> = {};

for (const s of samples) {
  const res = detectInjection(s.text);
  const predicted = res.detected;
  const actual = s.label === "injection";
  bySource[s.source] ??= { tp: 0, tn: 0, fp: 0, fn: 0 };
  if (predicted && actual) {
    tp++;
    bySource[s.source].tp++;
  } else if (!predicted && !actual) {
    tn++;
    bySource[s.source].tn++;
  } else if (predicted && !actual) {
    fp++;
    bySource[s.source].fp++;
  } else {
    fn++;
    bySource[s.source].fn++;
  }
}

const precision = tp / (tp + fp);
const recall = tp / (tp + fn);
const f1 = (2 * precision * recall) / (precision + recall);
const accuracy = (tp + tn) / samples.length;
const fpr = fp / (fp + tn);

console.log("=== LIB v1 full-dataset regex-detector baseline ===");
console.log(`Samples: ${samples.length} (${tp + fn} attacks, ${tn + fp} benign)`);
console.log(`TP=${tp} TN=${tn} FP=${fp} FN=${fn}`);
console.log(`Precision: ${(precision * 100).toFixed(2)}%`);
console.log(`Recall:    ${(recall * 100).toFixed(2)}%`);
console.log(`F1:        ${(f1 * 100).toFixed(2)}%`);
console.log(`Accuracy:  ${(accuracy * 100).toFixed(2)}%`);
console.log(`FPR:       ${(fpr * 100).toFixed(2)}%`);
console.log();
console.log("=== By source ===");
const entries = Object.entries(bySource).sort(
  (a, b) => b[1].tp + b[1].tn + b[1].fp + b[1].fn - (a[1].tp + a[1].tn + a[1].fp + a[1].fn),
);
for (const [src, m] of entries) {
  const n = m.tp + m.tn + m.fp + m.fn;
  const attacks = m.tp + m.fn;
  const benign = m.tn + m.fp;
  const accSrc = (((m.tp + m.tn) / n) * 100).toFixed(1);
  console.log(
    `${src.padEnd(55)} n=${n.toString().padStart(4)} att=${attacks.toString().padStart(4)} ben=${benign.toString().padStart(4)} TP=${m.tp.toString().padStart(4)} TN=${m.tn.toString().padStart(4)} FP=${m.fp.toString().padStart(4)} FN=${m.fn.toString().padStart(4)} acc=${accSrc}%`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  detector: "governance-sdk/injection-detect (regex, 54 patterns, 7 categories)",
  dataset: "Lua Injection Benchmark (LIB) v1",
  totalSamples: samples.length,
  attacks: tp + fn,
  benign: tn + fp,
  confusion: { tp, tn, fp, fn },
  precision,
  recall,
  f1,
  accuracy,
  falsePositiveRate: fpr,
  bySource,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log();
console.log(`Report written to ${OUT}`);
