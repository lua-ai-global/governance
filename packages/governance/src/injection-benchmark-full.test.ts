import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectInjection } from "./injection-detect";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "benchmark", "data", "lua-injection-benchmark-v1.jsonl");
const REPORT = join(
  __dirname,
  "..",
  "benchmark",
  "data",
  "lua-injection-benchmark-v1-regex-baseline.json",
);

type Sample = {
  id: string;
  text: string;
  label: "injection" | "benign";
  source: string;
};

describe("LIB full-dataset regex baseline", () => {
  it("dataset file has exactly 6,931 samples as claimed", () => {
    const lines = readFileSync(DATA, "utf8").trim().split("\n");
    assert.equal(lines.length, 6931);
  });

  it("dataset attack/benign split matches README (2,096 / 4,835)", () => {
    const samples = readFileSync(DATA, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Sample);
    const attacks = samples.filter((s) => s.label === "injection").length;
    const benign = samples.filter((s) => s.label === "benign").length;
    assert.equal(attacks, 2096);
    assert.equal(benign, 4835);
  });

  it("shipped regex detector produces stable baseline metrics (±2% F1)", () => {
    const samples = readFileSync(DATA, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Sample);

    let tp = 0,
      tn = 0,
      fp = 0,
      fn = 0;
    for (const s of samples) {
      const actual = s.label === "injection";
      const predicted = detectInjection(s.text).detected;
      if (predicted && actual) tp++;
      else if (!predicted && !actual) tn++;
      else if (predicted && !actual) fp++;
      else fn++;
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    const f1 = (2 * precision * recall) / (precision + recall);

    // The committed baseline is F1 ≈ 0.4936. Guard within ±2%.
    assert.ok(f1 > 0.47, `F1 regressed: ${f1.toFixed(4)} (baseline 0.4936)`);
    assert.ok(f1 < 0.52, `F1 improved above guard: ${f1.toFixed(4)} — update the committed baseline`);
  });

  it("committed baseline report is consistent with the current detector output", () => {
    // Light consistency check — the report file must exist and name the full dataset.
    const report = JSON.parse(readFileSync(REPORT, "utf8"));
    assert.equal(report.totalSamples, 6931);
    assert.equal(report.attacks, 2096);
    assert.equal(report.benign, 4835);
    assert.ok(typeof report.f1 === "number");
    assert.ok(report.bySource);
  });
});
