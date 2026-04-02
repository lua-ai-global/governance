#!/usr/bin/env npx tsx
/**
 * Label Validation — Trust reputable sources, validate the rest.
 *
 * Strategy:
 * - Samples from reputable labeled datasets (deepset, jackhhao, hackaprompt,
 *   Harelix) → auto-accept their labels (these are human-labeled or validated)
 * - Generated samples (encoding attacks, hard negatives) → auto-accept
 *   (we generated them, we know the labels)
 * - Only flag samples that have conflicting signals AND come from
 *   unknown/untrusted sources
 *
 * Optionally runs heuristic consensus as a quality check and reports
 * disagreements, but doesn't discard samples from trusted sources.
 *
 * Input:  benchmark/data/merged-unvalidated.jsonl
 * Output: benchmark/data/validated.jsonl
 *         benchmark/data/needs-review.jsonl
 *         benchmark/data/validation-report.txt
 *
 * Usage: npx tsx benchmark/scripts/validate-labels.ts
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "data");

interface Sample {
  text: string;
  label: "injection" | "benign";
  source: string;
  category?: string;
  [key: string]: unknown;
}

interface ValidatedSample extends Sample {
  validation: {
    regexDetected: boolean;
    regexScore: number;
    sourceReliability: "trusted" | "generated" | "unknown";
    heuristicAgreement: boolean;
    confidence: "high" | "medium" | "low";
  };
}

// ─── Trusted Sources ────────────────────────────────────────

const TRUSTED_SOURCES = new Set([
  "deepset/prompt-injections",
  "jackhhao/jailbreak-classification",
  "hackaprompt/hackaprompt-dataset",
  "Harelix/Prompt-Injection-Mixed-Techniques-2024",
]);

const GENERATED_SOURCES = new Set([
  "generated-encoding",
  "generated-hard-negatives",
]);

// ─── Heuristic Check (for reporting, not filtering) ─────────

const INJECTION_KEYWORDS = [
  "ignore", "disregard", "forget", "override", "bypass", "circumvent",
  "disable", "jailbreak", "DAN", "unrestricted", "unfiltered",
  "system prompt", "reveal", "dump", "exfiltrate", "leak",
  "developer mode", "god mode", "sudo",
];

function heuristicCheck(text: string): boolean {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of INJECTION_KEYWORDS) {
    if (lower.includes(kw)) hits++;
  }
  return hits >= 1;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const inputPath = join(DATA_DIR, "merged-unvalidated.jsonl");
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    console.error("Run merge-datasets.ts first.");
    process.exit(1);
  }

  const { detectInjection } = await import("../../dist/injection-detect.js");

  const lines = readFileSync(inputPath, "utf-8").trim().split("\n");
  const samples: Sample[] = lines.map((l) => JSON.parse(l));

  console.log(`Validating ${samples.length} samples...`);

  const validated: ValidatedSample[] = [];
  const needsReview: ValidatedSample[] = [];
  let trustedCount = 0, generatedCount = 0, unknownCount = 0;
  let heuristicDisagree = 0;

  for (const sample of samples) {
    const regexResult = detectInjection(sample.text);
    const heuristicSaysInjection = heuristicCheck(sample.text);
    const regexAgreesWithLabel = (sample.label === "injection") === regexResult.detected;
    const heuristicAgreesWithLabel = (sample.label === "injection") === heuristicSaysInjection;

    let sourceReliability: "trusted" | "generated" | "unknown";
    if (TRUSTED_SOURCES.has(sample.source)) sourceReliability = "trusted";
    else if (GENERATED_SOURCES.has(sample.source)) sourceReliability = "generated";
    else sourceReliability = "unknown";

    // Determine confidence
    let confidence: "high" | "medium" | "low";
    if (sourceReliability === "trusted" || sourceReliability === "generated") {
      // Trust the source label — high confidence unless both heuristics disagree
      confidence = (regexAgreesWithLabel || heuristicAgreesWithLabel) ? "high" : "medium";
    } else {
      // Unknown source — require heuristic agreement
      if (regexAgreesWithLabel && heuristicAgreesWithLabel) confidence = "high";
      else if (regexAgreesWithLabel || heuristicAgreesWithLabel) confidence = "medium";
      else confidence = "low";
    }

    if (!regexAgreesWithLabel && !heuristicAgreesWithLabel) heuristicDisagree++;

    if (sourceReliability === "trusted") trustedCount++;
    else if (sourceReliability === "generated") generatedCount++;
    else unknownCount++;

    const v: ValidatedSample = {
      ...sample,
      validation: {
        regexDetected: regexResult.detected,
        regexScore: regexResult.score,
        sourceReliability,
        heuristicAgreement: regexAgreesWithLabel || heuristicAgreesWithLabel,
        confidence,
      },
    };

    // Only send to review if low confidence from unknown source
    if (confidence === "low" && sourceReliability === "unknown") {
      needsReview.push(v);
    } else {
      validated.push(v);
    }
  }

  const validatedPath = join(DATA_DIR, "validated.jsonl");
  const reviewPath = join(DATA_DIR, "needs-review.jsonl");

  writeFileSync(validatedPath, validated.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(reviewPath, needsReview.map((s) => JSON.stringify(s)).join("\n") + "\n");

  const highConf = validated.filter((s) => s.validation.confidence === "high").length;
  const medConf = validated.filter((s) => s.validation.confidence === "medium").length;
  const valInj = validated.filter((s) => s.label === "injection").length;
  const valBen = validated.filter((s) => s.label === "benign").length;

  // Write report
  const report = [
    `Validation Report`,
    `═════════════════`,
    `Total input:         ${samples.length}`,
    `Validated:           ${validated.length} (${highConf} high, ${medConf} medium)`,
    `  - Injections:      ${valInj}`,
    `  - Benign:          ${valBen}`,
    `Needs review:        ${needsReview.length}`,
    ``,
    `Source breakdown:`,
    `  Trusted sources:   ${trustedCount}`,
    `  Generated:         ${generatedCount}`,
    `  Unknown:           ${unknownCount}`,
    ``,
    `Heuristic disagreements: ${heuristicDisagree} (${((heuristicDisagree / samples.length) * 100).toFixed(1)}%)`,
    `(These are samples where both regex and keyword heuristics disagree with the source label)`,
  ].join("\n");

  writeFileSync(join(DATA_DIR, "validation-report.txt"), report);

  console.log(`\n${report}`);
  console.log(`\nOutput: ${validatedPath}`);
  console.log(`Review: ${reviewPath}`);
}

main().catch(console.error);
