#!/usr/bin/env npx tsx
/**
 * Master Pipeline — Build the Lua Injection Benchmark from scratch.
 *
 * Runs all steps in order:
 * 1. Fetch datasets from HuggingFace
 * 2. Generate encoding attack samples
 * 3. Generate hard negative samples
 * 4. Merge and deduplicate all sources
 * 5. Validate labels via multi-detector consensus
 * 6. Build final benchmark dataset
 * 7. Run benchmark against our detector
 *
 * Usage: npx tsx benchmark/scripts/run-pipeline.ts
 *
 * If HuggingFace fetch fails (network issues), the pipeline
 * continues with generated data only.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";

const SCRIPTS_DIR = import.meta.dirname;

function run(script: string, description: string) {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Step: ${description}`);
  console.log(`${"═".repeat(50)}\n`);

  try {
    execSync(`npx tsx ${join(SCRIPTS_DIR, script)}`, {
      stdio: "inherit",
      cwd: join(SCRIPTS_DIR, "..", ".."),
      timeout: 120_000,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (script === "fetch-datasets.ts") {
      console.log(`\n⚠ Dataset fetch failed (network issue?). Continuing with generated data.`);
      console.log(`  Error: ${msg.slice(0, 200)}`);
    } else {
      throw error;
    }
  }
}

async function main() {
  console.log(`╔═══════════════════════════════════════════════╗`);
  console.log(`║  Lua Injection Benchmark — Full Pipeline      ║`);
  console.log(`╚═══════════════════════════════════════════════╝`);

  const start = performance.now();

  // Step 1: Fetch external datasets
  run("fetch-datasets.ts", "Fetch datasets from HuggingFace");

  // Step 2: Generate encoding attacks
  run("generate-encoding-attacks.ts", "Generate encoding attack samples");

  // Step 3: Generate hard negatives
  run("generate-hard-negatives.ts", "Generate hard negative samples");

  // Step 4: Merge everything
  run("merge-datasets.ts", "Merge, deduplicate, and balance");

  // Step 5: Validate labels
  run("validate-labels.ts", "Validate labels via multi-detector consensus");

  // Step 6: Build final dataset
  run("build-final-dataset.ts", "Build final benchmark dataset");

  // Step 7: Run benchmark
  run("run-benchmark.ts", "Run benchmark against regex detector");

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);

  console.log(`\n╔═══════════════════════════════════════════════╗`);
  console.log(`║  Pipeline complete in ${elapsed.padEnd(6)}s                  ║`);
  console.log(`╚═══════════════════════════════════════════════╝`);
}

main().catch((err) => {
  console.error("\nPipeline failed:", err.message);
  process.exit(1);
});
