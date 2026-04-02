#!/usr/bin/env npx tsx
/**
 * Build the final benchmark dataset from validated samples.
 *
 * Takes validated.jsonl, strips internal validation metadata,
 * assigns stable IDs, computes stats, and outputs the final
 * benchmark in multiple formats.
 *
 * Input:  benchmark/data/validated.jsonl
 * Output: benchmark/data/lua-injection-benchmark-v1.json  (full dataset)
 *         benchmark/data/lua-injection-benchmark-v1.jsonl (line-delimited)
 *
 * Usage: npx tsx benchmark/scripts/build-final-dataset.ts
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "data");

interface ValidatedSample {
  text: string;
  label: "injection" | "benign";
  source: string;
  category?: string;
  validation?: unknown;
  [key: string]: unknown;
}

interface BenchmarkEntry {
  id: string;
  text: string;
  label: "injection" | "benign";
  category: string;
  source: string;
}

interface BenchmarkDataset {
  name: string;
  version: string;
  description: string;
  license: string;
  created: string;
  stats: {
    total: number;
    injections: number;
    benign: number;
    categories: Record<string, number>;
    sources: Record<string, number>;
    splits?: { train: number; validation: number; test: number };
  };
  samples: BenchmarkEntry[];
  splits?: { train: BenchmarkEntry[]; validation: BenchmarkEntry[]; test: BenchmarkEntry[] };
}

// ─── Main ───────────────────────────────────────────────────

const inputPath = join(DATA_DIR, "validated.jsonl");
if (!existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  console.error("Run the full pipeline first: npx tsx benchmark/scripts/run-pipeline.ts");
  process.exit(1);
}

const lines = readFileSync(inputPath, "utf-8").trim().split("\n").filter(Boolean);
const samples: ValidatedSample[] = lines.map((l) => JSON.parse(l));

// Assign stable IDs
const entries: BenchmarkEntry[] = samples.map((s, i) => ({
  id: `LIB-${String(i + 1).padStart(5, "0")}`,
  text: s.text,
  label: s.label,
  category: s.category ?? (s.label === "injection" ? "uncategorized_attack" : "uncategorized_benign"),
  source: s.source,
}));

// Compute stats
const categories: Record<string, number> = {};
const sources: Record<string, number> = {};
for (const e of entries) {
  categories[e.category] = (categories[e.category] ?? 0) + 1;
  sources[e.source] = (sources[e.source] ?? 0) + 1;
}

// ─── Train / Test / Validation Split ────────────────────────
// 60% test (the benchmark), 20% validation (for tuning), 20% train (for model fine-tuning)
// Deterministic split by hashing the ID

function splitData(data: BenchmarkEntry[]): { train: BenchmarkEntry[]; validation: BenchmarkEntry[]; test: BenchmarkEntry[] } {
  const train: BenchmarkEntry[] = [];
  const validation: BenchmarkEntry[] = [];
  const test: BenchmarkEntry[] = [];

  for (const entry of data) {
    let hash = 0;
    for (let i = 0; i < entry.id.length; i++) hash = ((hash << 5) - hash + entry.id.charCodeAt(i)) | 0;
    const bucket = Math.abs(hash) % 10;

    if (bucket < 6) test.push(entry);       // 60%
    else if (bucket < 8) validation.push(entry); // 20%
    else train.push(entry);                      // 20%
  }

  return { train, validation, test };
}

const splits = splitData(entries);

const dataset: BenchmarkDataset = {
  name: "Lua Injection Benchmark (LIB)",
  version: "1.0.0",
  description: "Curated benchmark for prompt injection detection. Multi-source, multi-category, with hard negatives and encoding attacks. Includes train/validation/test splits.",
  license: "MIT",
  created: new Date().toISOString(),
  stats: {
    total: entries.length,
    injections: entries.filter((e) => e.label === "injection").length,
    benign: entries.filter((e) => e.label === "benign").length,
    categories,
    sources,
    splits: {
      train: splits.train.length,
      validation: splits.validation.length,
      test: splits.test.length,
    },
  },
  samples: entries,
  splits: {
    train: splits.train,
    validation: splits.validation,
    test: splits.test,
  },
};

// Write full JSON
const jsonPath = join(DATA_DIR, "lua-injection-benchmark-v1.json");
writeFileSync(jsonPath, JSON.stringify(dataset, null, 2));

// Write JSONL (samples only — full)
const jsonlPath = join(DATA_DIR, "lua-injection-benchmark-v1.jsonl");
writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

// Write split files
for (const [name, split] of Object.entries(splits)) {
  const splitPath = join(DATA_DIR, `lua-injection-benchmark-v1-${name}.jsonl`);
  writeFileSync(splitPath, split.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

console.log(`═══════════════════════════════════════════════`);
console.log(`  Lua Injection Benchmark v1.0.0`);
console.log(`═══════════════════════════════════════════════`);
console.log(`  Total:        ${dataset.stats.total}`);
console.log(`  Injections:   ${dataset.stats.injections}`);
console.log(`  Benign:       ${dataset.stats.benign}`);
console.log(`  Categories:   ${Object.keys(categories).length}`);
console.log(`  Sources:      ${Object.keys(sources).length}`);
console.log(`\n  Categories:`);
for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${cat.padEnd(35)} ${count}`);
}
console.log(`\n  Sources:`);
for (const [src, count] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${src.padEnd(45)} ${count}`);
}
console.log(`\n  Splits:`);
console.log(`    Train:      ${splits.train.length} (${splits.train.filter(e => e.label === "injection").length} atk, ${splits.train.filter(e => e.label === "benign").length} ben)`);
console.log(`    Validation: ${splits.validation.length} (${splits.validation.filter(e => e.label === "injection").length} atk, ${splits.validation.filter(e => e.label === "benign").length} ben)`);
console.log(`    Test:       ${splits.test.length} (${splits.test.filter(e => e.label === "injection").length} atk, ${splits.test.filter(e => e.label === "benign").length} ben)`);
console.log(`\n  Output:`);
console.log(`    ${jsonPath}`);
console.log(`    ${jsonlPath}`);
for (const name of ["train", "validation", "test"]) {
  console.log(`    ${join(DATA_DIR, `lua-injection-benchmark-v1-${name}.jsonl`)}`);
}
console.log(`═══════════════════════════════════════════════`);
