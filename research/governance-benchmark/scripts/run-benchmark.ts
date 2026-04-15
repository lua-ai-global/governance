#!/usr/bin/env npx tsx
/**
 * Run the regex detector against the generated AGB dataset.
 */
import { generateDataset } from "../src/index.js";
import { runBenchmark, formatResults } from "../src/runner.js";
import { detectInjection } from "../../governance/dist/injection-detect.js";

const target = parseInt(process.argv[2] ?? "10000");
console.log(`Generating ${target} samples...`);
const samples = generateDataset({ target });
const testSamples = samples.filter((s) => s.split === "test");
console.log(`Test split: ${testSamples.length} samples\n`);

const results = await runBenchmark(
  testSamples,
  (input) => {
    const r = detectInjection(input);
    return { detected: r.detected, score: r.score };
  },
  "lua-governance-regex",
);

console.log(formatResults(results));

// Show top missed categories
const missedByCat = new Map<string, number>();
for (const f of results.failures.filter((f) => f.expected === "injection")) {
  missedByCat.set(f.category, (missedByCat.get(f.category) ?? 0) + 1);
}
if (missedByCat.size > 0) {
  console.log("\nMost missed attack categories:");
  for (const [cat, count] of [...missedByCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const total = results.perCategory[cat]?.total ?? 0;
    console.log(`  ${cat.padEnd(28)} ${count}/${total} missed`);
  }
}

// Show FP categories
const fpByCat = new Map<string, number>();
for (const f of results.failures.filter((f) => f.expected === "benign")) {
  fpByCat.set(f.category, (fpByCat.get(f.category) ?? 0) + 1);
}
if (fpByCat.size > 0) {
  console.log("\nFalse positive categories:");
  for (const [cat, count] of [...fpByCat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(28)} ${count} false positives`);
  }
}
