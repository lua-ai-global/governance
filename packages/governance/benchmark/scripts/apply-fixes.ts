#!/usr/bin/env npx tsx
/**
 * Apply LLM-audited label corrections to the benchmark dataset.
 *
 * Reads label-fixes.json and updates the main dataset + split files.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "data");

const fixesPath = join(DATA_DIR, "label-fixes.json");
const datasetPath = join(DATA_DIR, "lua-injection-benchmark-v1.json");

if (!existsSync(fixesPath) || !existsSync(datasetPath)) {
  console.error("Missing files. Run llm-audit.ts first.");
  process.exit(1);
}

const fixes: Array<{ id: string; correctedLabel: string }> = JSON.parse(readFileSync(fixesPath, "utf-8"));
const fixMap = new Map(fixes.map((f) => [f.id, f.correctedLabel]));

const dataset = JSON.parse(readFileSync(datasetPath, "utf-8"));

let fixed = 0;

// Fix in main samples array
for (const sample of dataset.samples) {
  const correction = fixMap.get(sample.id);
  if (correction) {
    const oldLabel = sample.label;
    sample.label = correction;
    // Move category to reflect the correction
    if (correction === "injection" && !sample.category?.includes("injection")) {
      sample.category = "llm_verified_injection";
    }
    fixed++;
  }
}

// Fix in splits
for (const splitName of ["train", "validation", "test"]) {
  if (!dataset.splits?.[splitName]) continue;
  for (const sample of dataset.splits[splitName]) {
    const correction = fixMap.get(sample.id);
    if (correction) {
      sample.label = correction;
      if (correction === "injection" && !sample.category?.includes("injection")) {
        sample.category = "llm_verified_injection";
      }
    }
  }
}

// Recompute stats
const injections = dataset.samples.filter((s: any) => s.label === "injection").length;
const benign = dataset.samples.filter((s: any) => s.label === "benign").length;
dataset.stats.injections = injections;
dataset.stats.benign = benign;

// Save
writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));

// Update split files
for (const splitName of ["train", "validation", "test"]) {
  if (!dataset.splits?.[splitName]) continue;
  const splitPath = join(DATA_DIR, `lua-injection-benchmark-v1-${splitName}.jsonl`);
  writeFileSync(splitPath, dataset.splits[splitName].map((s: any) => JSON.stringify(s)).join("\n") + "\n");
}

// Update JSONL
const jsonlPath = join(DATA_DIR, "lua-injection-benchmark-v1.jsonl");
writeFileSync(jsonlPath, dataset.samples.map((s: any) => JSON.stringify(s)).join("\n") + "\n");

console.log(`Applied ${fixed} label corrections`);
console.log(`  New totals: ${injections} attacks, ${benign} benign`);
console.log(`  Dataset updated: ${datasetPath}`);
