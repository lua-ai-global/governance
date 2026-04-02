#!/usr/bin/env npx tsx
/**
 * Merge, deduplicate, and balance all dataset sources into one file.
 *
 * Reads all raw-*.jsonl and generated-*.jsonl from benchmark/data/,
 * deduplicates by text similarity, balances injection/benign ratio,
 * and outputs a single merged file.
 *
 * Input:  benchmark/data/raw-*.jsonl, benchmark/data/generated-*.jsonl
 * Output: benchmark/data/merged-unvalidated.jsonl
 *
 * Usage: npx tsx benchmark/scripts/merge-datasets.ts
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "data");

interface Sample {
  text: string;
  label: "injection" | "benign";
  source: string;
  category?: string;
  [key: string]: unknown;
}

// ─── Load All Sources ───────────────────────────────────────

function loadJsonlFiles(pattern: string): Sample[] {
  const files = readdirSync(DATA_DIR).filter((f) => f.match(new RegExp(pattern)) && f.endsWith(".jsonl"));
  const samples: Sample[] = [];

  for (const file of files) {
    const path = join(DATA_DIR, file);
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Sample;
        if (parsed.text && parsed.label) samples.push(parsed);
      } catch { /* skip malformed */ }
    }
    console.log(`  Loaded ${lines.length} samples from ${file}`);
  }

  return samples;
}

// ─── Deduplication ──────────────────────────────────────────

function deduplicate(samples: Sample[]): Sample[] {
  const seen = new Map<string, Sample>();

  for (const sample of samples) {
    // Normalize: lowercase, collapse whitespace, take first 200 chars
    const key = sample.text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
    if (!seen.has(key)) {
      seen.set(key, sample);
    }
  }

  return [...seen.values()];
}

// ─── Quality Filters ────────────────────────────────────────

function filterSamples(samples: Sample[]): Sample[] {
  return samples.filter((s) => {
    // Remove very short samples
    if (s.text.length < 10) return false;
    // Remove very long samples (cap at 2000 chars)
    if (s.text.length > 2000) { s.text = s.text.slice(0, 2000); }
    // Remove samples that are just whitespace/punctuation
    if (!/[a-zA-Z]{3,}/.test(s.text)) return false;
    return true;
  });
}

// ─── Sampling / Balancing ───────────────────────────────────

function balanceForTraining(samples: Sample[]): Sample[] {
  const injections = samples.filter((s) => s.label === "injection");
  const benign = samples.filter((s) => s.label === "benign");
  const shuffle = (arr: Sample[]) => arr.sort((a, b) => simpleHash(a.text) - simpleHash(b.text));

  // Training: ~2.5:1 benign:attack ratio
  // Use all attacks, sample benign to 2.5x
  const targetBenign = Math.min(benign.length, Math.round(injections.length * 2.5));
  return shuffle([...shuffle(injections), ...shuffle(benign).slice(0, targetBenign)]);
}

function balanceForEval(samples: Sample[], ratio: number = 20): Sample[] {
  const injections = samples.filter((s) => s.label === "injection");
  const benign = samples.filter((s) => s.label === "benign");
  const shuffle = (arr: Sample[]) => arr.sort((a, b) => simpleHash(a.text) - simpleHash(b.text));

  // Production eval: ratio:1 benign:attack (default 20:1)
  const targetBenign = Math.min(benign.length, injections.length * ratio);
  return shuffle([...shuffle(injections), ...shuffle(benign).slice(0, targetBenign)]);
}

function simpleHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

// ─── Main ───────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  Injection Benchmark — Dataset Merger");
console.log("═══════════════════════════════════════════════\n");

console.log("Loading raw datasets:");
const rawSamples = loadJsonlFiles("^raw-");

console.log("\nLoading generated datasets:");
const generatedSamples = loadJsonlFiles("^generated-");

const all = [...rawSamples, ...generatedSamples];
console.log(`\nTotal loaded: ${all.length}`);

const deduped = deduplicate(all);
console.log(`After dedup:  ${deduped.length}`);

const filtered = filterSamples(deduped);
console.log(`After filter: ${filtered.length}`);

const injCount = filtered.filter((s) => s.label === "injection").length;
const benCount = filtered.filter((s) => s.label === "benign").length;
console.log(`  Injections: ${injCount}`);
console.log(`  Benign:     ${benCount}`);

// Create TWO output sets:
// 1. Training set: ~2.5:1 benign:attack ratio
// 2. Production eval set: ~20:1 benign:attack (reflects real-world base rates)

const trainSet = balanceForTraining(filtered);
const evalSet = balanceForEval(filtered, 20);

// Also output the full unvalidated set for the validation pipeline
const fullPath = join(DATA_DIR, "merged-unvalidated.jsonl");
writeFileSync(fullPath, filtered.map((s) => JSON.stringify(s)).join("\n") + "\n");

const trainPath = join(DATA_DIR, "merged-train-balanced.jsonl");
writeFileSync(trainPath, trainSet.map((s) => JSON.stringify(s)).join("\n") + "\n");

const evalPath = join(DATA_DIR, "merged-eval-production.jsonl");
writeFileSync(evalPath, evalSet.map((s) => JSON.stringify(s)).join("\n") + "\n");

const trainInj = trainSet.filter((s) => s.label === "injection").length;
const trainBen = trainSet.filter((s) => s.label === "benign").length;
const evalInj = evalSet.filter((s) => s.label === "injection").length;
const evalBen = evalSet.filter((s) => s.label === "benign").length;

console.log(`\n═══════════════════════════════════════════════`);
console.log(`  Merged Datasets`);
console.log(`═══════════════════════════════════════════════`);
console.log(`  Full (unvalidated): ${filtered.length} (${injCount} atk, ${benCount} ben)`);
console.log(`  Sources: ${new Set(filtered.map((s) => s.source)).size}`);
console.log(`\n  Training set (2.5:1 ratio):`);
console.log(`    Total: ${trainSet.length} (${trainInj} atk, ${trainBen} ben, ratio ${(trainBen/trainInj).toFixed(1)}:1)`);
console.log(`\n  Production eval set (20:1 ratio):`);
console.log(`    Total: ${evalSet.length} (${evalInj} atk, ${evalBen} ben, ratio ${(evalBen/evalInj).toFixed(1)}:1)`);
console.log(`\n  Output:`);
console.log(`    ${fullPath}`);
console.log(`    ${trainPath}`);
console.log(`    ${evalPath}`);
console.log(`═══════════════════════════════════════════════`);
