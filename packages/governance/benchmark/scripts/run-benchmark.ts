#!/usr/bin/env npx tsx
/**
 * Lua Injection Benchmark — Industry-Standard Runner
 *
 * Reports:
 * - Overall precision/recall/F1/accuracy
 * - Attack categories: recall per category (what attacks are we missing?)
 * - Benign categories: FP rate per category (what legit text are we flagging?)
 * - Confusion matrix
 * - Worst failures with sample text
 *
 * Usage:
 *   npx tsx benchmark/scripts/run-benchmark.ts
 *   npx tsx benchmark/scripts/run-benchmark.ts --split=test --threshold=0.6
 *   npx tsx benchmark/scripts/run-benchmark.ts --json
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "data");

interface Sample {
  id: string;
  text: string;
  label: "injection" | "benign";
  category: string;
  source: string;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const thresholdArg = args.find((a) => a.startsWith("--threshold="));
  const threshold = thresholdArg ? parseFloat(thresholdArg.split("=")[1]) : 0.5;
  const splitArg = args.find((a) => a.startsWith("--split="));
  const splitName = splitArg ? splitArg.split("=")[1] : "test";

  const datasetPath = join(DATA_DIR, "lua-injection-benchmark-v1.json");
  if (!existsSync(datasetPath)) {
    console.error("Dataset not found. Run: npx tsx benchmark/scripts/run-pipeline.ts");
    process.exit(1);
  }

  const dataset = JSON.parse(readFileSync(datasetPath, "utf-8"));
  let samples: Sample[] = splitName === "all" ? dataset.samples : dataset.splits?.[splitName] ?? dataset.samples;

  const { detectInjection } = await import("../../dist/injection-detect.js");

  // ─── Run Detection ────────────────────────────────────────

  const start = performance.now();

  let tp = 0, fp = 0, tn = 0, fn = 0;

  // Track attack categories (for recall)
  const attackCats: Record<string, { total: number; caught: number; missed: number }> = {};
  // Track benign categories (for FP rate)
  const benignCats: Record<string, { total: number; fp: number; clean: number }> = {};

  const fpSamples: Array<{ id: string; text: string; score: number; category: string }> = [];
  const fnSamples: Array<{ id: string; text: string; score: number; category: string }> = [];

  for (const sample of samples) {
    const result = detectInjection(sample.text, { threshold });
    const expected = sample.label === "injection";
    const got = result.detected;

    if (expected) {
      // Attack sample
      const cat = sample.category || "uncategorized";
      if (!attackCats[cat]) attackCats[cat] = { total: 0, caught: 0, missed: 0 };
      attackCats[cat].total++;

      if (got) {
        tp++;
        attackCats[cat].caught++;
      } else {
        fn++;
        attackCats[cat].missed++;
        if (fnSamples.length < 20) fnSamples.push({ id: sample.id, text: sample.text.slice(0, 120), score: result.score, category: cat });
      }
    } else {
      // Benign sample
      const cat = sample.category || "uncategorized";
      if (!benignCats[cat]) benignCats[cat] = { total: 0, fp: 0, clean: 0 };
      benignCats[cat].total++;

      if (got) {
        fp++;
        benignCats[cat].fp++;
        if (fpSamples.length < 20) fpSamples.push({ id: sample.id, text: sample.text.slice(0, 120), score: result.score, category: cat });
      } else {
        tn++;
        benignCats[cat].clean++;
      }
    }
  }

  const elapsed = performance.now() - start;
  const totalInj = tp + fn;
  const totalBen = fp + tn;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + tn) / samples.length;
  const fpRate = totalBen > 0 ? fp / totalBen : 0;
  const fnRate = totalInj > 0 ? fn / totalInj : 0;

  // ─── JSON Output ──────────────────────────────────────────

  if (jsonOutput) {
    console.log(JSON.stringify({
      detector: "regex", split: splitName, threshold, samples: samples.length,
      attacks: totalInj, benign: totalBen,
      tp, fp, tn, fn, precision, recall, f1, accuracy, fpRate, fnRate,
      latencyMs: Math.round(elapsed),
      attackCategories: attackCats, benignCategories: benignCats,
      fpSamples, fnSamples,
    }, null, 2));
    return;
  }

  // ─── Human-Readable Output ────────────────────────────────

  const W = 66; // box width
  const line = (s: string) => console.log(s);
  const boxLine = (content: string) => line(`║  ${content}${" ".repeat(Math.max(0, W - 4 - content.length))}║`);
  const sep = () => line(`╠${"═".repeat(W - 2)}╣`);

  line(`╔${"═".repeat(W - 2)}╗`);
  boxLine(`Lua Injection Benchmark`);
  sep();
  boxLine(`Detector:     regex-only`);
  boxLine(`Split:        ${splitName}`);
  boxLine(`Threshold:    ${threshold}`);
  boxLine(`Samples:      ${samples.length} (${totalInj} attacks, ${totalBen} benign)`);
  boxLine(`Latency:      ${elapsed.toFixed(0)}ms total (${(elapsed / samples.length).toFixed(2)}ms/sample)`);
  sep();

  // ─── Overall Metrics ──────────────────────────────────────
  boxLine(`OVERALL METRICS`);
  boxLine(``);
  boxLine(`  Precision:  ${(precision * 100).toFixed(1)}%    (${tp} correct of ${tp + fp} flagged)`);
  boxLine(`  Recall:     ${(recall * 100).toFixed(1)}%    (${tp} caught of ${totalInj} attacks)`);
  boxLine(`  F1 Score:   ${(f1 * 100).toFixed(1)}%`);
  boxLine(`  Accuracy:   ${(accuracy * 100).toFixed(1)}%`);
  boxLine(``);
  boxLine(`  FP Rate:    ${(fpRate * 100).toFixed(1)}%    (${fp} false alarms on ${totalBen} benign)`);
  boxLine(`  FN Rate:    ${(fnRate * 100).toFixed(1)}%    (${fn} missed of ${totalInj} attacks)`);
  sep();

  // ─── Confusion Matrix ─────────────────────────────────────
  boxLine(`CONFUSION MATRIX`);
  boxLine(``);
  boxLine(`                      Predicted`);
  boxLine(`                   Attack    Benign`);
  boxLine(`  Actual Attack   ${String(tp).padStart(5)}     ${String(fn).padStart(5)}    (${totalInj} total)`);
  boxLine(`  Actual Benign   ${String(fp).padStart(5)}     ${String(tn).padStart(5)}    (${totalBen} total)`);
  sep();

  // ─── Attack Category Recall ───────────────────────────────
  boxLine(`ATTACK DETECTION BY CATEGORY (Recall)`);
  boxLine(``);

  const sortedAttackCats = Object.entries(attackCats).sort((a, b) => b[1].total - a[1].total);
  for (const [cat, stats] of sortedAttackCats) {
    const recallPct = stats.total > 0 ? ((stats.caught / stats.total) * 100).toFixed(0) : "0";
    const bar = makeBar(stats.caught / stats.total, 20);
    const shortCat = cat.length > 24 ? cat.slice(0, 23) + "…" : cat;
    boxLine(`  ${shortCat.padEnd(25)} ${bar} ${recallPct.padStart(3)}%  (${stats.caught}/${stats.total})`);
  }
  sep();

  // ─── Benign Category FP Rate ──────────────────────────────
  boxLine(`FALSE POSITIVE RATE BY BENIGN CATEGORY`);
  boxLine(``);

  const sortedBenignCats = Object.entries(benignCats).sort((a, b) => b[1].total - a[1].total);
  for (const [cat, stats] of sortedBenignCats) {
    const fpPct = stats.total > 0 ? ((stats.fp / stats.total) * 100).toFixed(1) : "0.0";
    const status = stats.fp === 0 ? "✓ clean" : `⚠ ${stats.fp} FP`;
    const shortCat = cat.length > 24 ? cat.slice(0, 23) + "…" : cat;
    boxLine(`  ${shortCat.padEnd(25)} ${String(stats.total).padStart(5)} samples  ${fpPct.padStart(5)}%  ${status}`);
  }
  sep();

  // ─── Source Distribution ──────────────────────────────────
  boxLine(`DATA SOURCES`);
  boxLine(``);
  const sourceCounts: Record<string, number> = {};
  for (const s of samples) sourceCounts[s.source] = (sourceCounts[s.source] ?? 0) + 1;
  for (const [src, count] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    const shortSrc = src.length > 40 ? src.slice(0, 39) + "…" : src;
    boxLine(`  ${shortSrc.padEnd(42)} ${String(count).padStart(5)}`);
  }
  sep();

  // ─── Worst False Positives ────────────────────────────────
  if (fpSamples.length > 0) {
    boxLine(`WORST FALSE POSITIVES (benign text incorrectly flagged)`);
    boxLine(``);
    for (const f of fpSamples.slice(0, 8)) {
      boxLine(`  [${f.category}] score=${f.score}`);
      boxLine(`    "${f.text.slice(0, 55)}${f.text.length > 55 ? "..." : ""}"`);
    }
    if (fpSamples.length > 8) boxLine(`  ... and ${fpSamples.length - 8} more`);
    sep();
  }

  // ─── Worst False Negatives ────────────────────────────────
  if (fnSamples.length > 0) {
    boxLine(`WORST FALSE NEGATIVES (attacks that slipped through)`);
    boxLine(``);
    for (const f of fnSamples.slice(0, 8)) {
      boxLine(`  [${f.category}] score=${f.score}`);
      boxLine(`    "${f.text.slice(0, 55)}${f.text.length > 55 ? "..." : ""}"`);
    }
    if (fnSamples.length > 8) boxLine(`  ... and ${fnSamples.length - 8} more`);
    sep();
  }

  line(`╚${"═".repeat(W - 2)}╝`);
}

function makeBar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

main().catch(console.error);
