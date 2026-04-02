#!/usr/bin/env npx tsx
/**
 * Precision-Recall Threshold Sweep
 *
 * Runs the hybrid detector (regex + ML) at multiple ML thresholds
 * to find the optimal decision boundary. Uses the validation split
 * for tuning, then reports the recommended threshold.
 *
 * Usage:
 *   npx tsx benchmark/scripts/threshold-sweep.ts
 *   npx tsx benchmark/scripts/threshold-sweep.ts --split=test   # final eval
 *
 * Output: Table of precision/recall/F1/FP-rate at each threshold
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "data");

interface BenchmarkEntry {
  id: string;
  text: string;
  label: "injection" | "benign";
  category: string;
  source: string;
}

async function main() {
  const args = process.argv.slice(2);
  const splitArg = args.find((a) => a.startsWith("--split="));
  const splitName = splitArg ? splitArg.split("=")[1] : "validation";

  // Load dataset
  const datasetPath = join(DATA_DIR, "lua-injection-benchmark-v1.json");
  if (!existsSync(datasetPath)) {
    console.error("Dataset not found. Run the pipeline first.");
    process.exit(1);
  }

  const dataset = JSON.parse(readFileSync(datasetPath, "utf-8"));
  const samples: BenchmarkEntry[] = dataset.splits?.[splitName] ?? dataset.samples;
  const totalInj = samples.filter((s) => s.label === "injection").length;
  const totalBen = samples.filter((s) => s.label === "benign").length;

  console.log(`\nLoading detectors...`);

  // Load regex detector
  const { detectInjection } = await import("../../dist/injection-detect.js");

  // Load ML classifier
  const mlPath = join(import.meta.dirname, "..", "..", "..", "..", "..", "governance-cloud", "packages", "governance-ml");
  const { createClassifier } = await import(join(mlPath, "src", "classifier.ts"));
  const classifier = await createClassifier({});
  await classifier.warmup();

  console.log(`Detectors loaded.\n`);
  console.log(`Split: ${splitName} (${samples.length} samples: ${totalInj} attacks, ${totalBen} benign)\n`);

  // Pre-compute regex results
  const regexResults = samples.map((s) => detectInjection(s.text, { threshold: 0.5 }));

  // Pre-compute ML scores for samples regex missed
  console.log(`Running ML on ${samples.length} samples...`);
  const BATCH = 20;
  const mlScores: (number | null)[] = new Array(samples.length).fill(null);

  for (let b = 0; b < samples.length; b += BATCH) {
    const batch = samples.slice(b, b + BATCH);
    const results = await Promise.allSettled(
      batch.map((s) => classifier.classify(s.text))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        mlScores[b + j] = r.value.score;
      }
    }
    if ((b + BATCH) % 100 === 0 || b + BATCH >= samples.length) {
      process.stdout.write(`  ${Math.min(b + BATCH, samples.length)}/${samples.length}\r`);
    }
  }
  console.log(`\nML scoring complete.\n`);

  // Sweep thresholds
  const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];

  console.log(`ML Thresh │ Precision │ Recall │ F1     │ FP Rate │ FN Rate │ TP   │ FP  │ FN  │ TN`);
  console.log(`──────────┼───────────┼────────┼────────┼─────────┼─────────┼──────┼─────┼─────┼─────`);

  let bestF1 = 0;
  let bestThreshold = 0.5;
  let bestAtLowFP = { threshold: 0.5, f1: 0, recall: 0, precision: 0, fpRate: 1 };

  for (const mlThreshold of thresholds) {
    let tp = 0, fp = 0, tn = 0, fn = 0;

    for (let i = 0; i < samples.length; i++) {
      const expected = samples[i].label === "injection";
      const regexDetected = regexResults[i].detected;

      let detected = regexDetected;
      if (!regexDetected && mlScores[i] !== null) {
        detected = mlScores[i]! >= mlThreshold;
      }

      if (expected && detected) tp++;
      else if (!expected && !detected) tn++;
      else if (!expected && detected) fp++;
      else fn++;
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
    const fpRate = totalBen > 0 ? fp / totalBen : 0;
    const fnRate = totalInj > 0 ? fn / totalInj : 0;

    const marker = (fpRate <= 0.05 && f1 > bestAtLowFP.f1) ? " ◀" : "";
    if (fpRate <= 0.05 && f1 > bestAtLowFP.f1) {
      bestAtLowFP = { threshold: mlThreshold, f1, recall, precision, fpRate };
    }
    if (f1 > bestF1) { bestF1 = f1; bestThreshold = mlThreshold; }

    console.log(
      `  ${mlThreshold.toFixed(2)}    │ ${(precision * 100).toFixed(1).padStart(7)}% │ ${(recall * 100).toFixed(1).padStart(5)}% │ ${(f1 * 100).toFixed(1).padStart(5)}% │ ${(fpRate * 100).toFixed(1).padStart(6)}% │ ${(fnRate * 100).toFixed(1).padStart(6)}% │ ${String(tp).padStart(4)} │ ${String(fp).padStart(3)} │ ${String(fn).padStart(3)} │ ${String(tn).padStart(3)}${marker}`
    );
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`Best F1:            ${(bestF1 * 100).toFixed(1)}% at threshold ${bestThreshold}`);
  if (bestAtLowFP.f1 > 0) {
    console.log(`Best F1 (FP ≤ 5%):  ${(bestAtLowFP.f1 * 100).toFixed(1)}% at threshold ${bestAtLowFP.threshold}`);
    console.log(`  → Precision: ${(bestAtLowFP.precision * 100).toFixed(1)}%, Recall: ${(bestAtLowFP.recall * 100).toFixed(1)}%, FP Rate: ${(bestAtLowFP.fpRate * 100).toFixed(1)}%`);
    console.log(`\n✅ Recommended ML threshold: ${bestAtLowFP.threshold}`);
  } else {
    console.log(`⚠ No threshold achieved FP ≤ 5%. Consider using regex-only or a different model.`);
  }
  console.log(`${"═".repeat(70)}`);
}

main().catch(console.error);
