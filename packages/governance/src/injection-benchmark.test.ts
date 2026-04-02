import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runBenchmark, BENCHMARK_DATASET } from "./injection-benchmark";
import { detectInjection } from "./injection-detect";

describe("Injection Detection Benchmark", () => {
  it("dataset has balanced attack and benign samples", () => {
    const attacks = BENCHMARK_DATASET.filter((s) => s.label === "injection");
    const benign = BENCHMARK_DATASET.filter((s) => s.label === "benign");
    assert.ok(attacks.length >= 40, `Expected >= 40 attacks, got ${attacks.length}`);
    assert.ok(benign.length >= 25, `Expected >= 25 benign, got ${benign.length}`);
  });

  it("dataset covers all 7 attack categories", () => {
    const attackCats = new Set(BENCHMARK_DATASET.filter((s) => s.label === "injection").map((s) => s.category));
    assert.ok(attackCats.has("instruction_override"));
    assert.ok(attackCats.has("role_manipulation"));
    assert.ok(attackCats.has("context_escape"));
    assert.ok(attackCats.has("data_exfiltration"));
    assert.ok(attackCats.has("encoding_attack"));
    assert.ok(attackCats.has("social_engineering"));
    assert.ok(attackCats.has("obfuscation"));
  });

  it("dataset includes hard negatives", () => {
    const hardNegs = BENCHMARK_DATASET.filter((s) => s.category === "hard_negative");
    assert.ok(hardNegs.length >= 15, `Expected >= 15 hard negatives, got ${hardNegs.length}`);
  });

  it("all sample IDs are unique", () => {
    const ids = BENCHMARK_DATASET.map((s) => s.id);
    assert.equal(ids.length, new Set(ids).size);
  });

  it("regex detector achieves F1 >= 0.85 on benchmark", async () => {
    const results = await runBenchmark((input) => {
      const r = detectInjection(input);
      return { detected: r.detected, score: r.score };
    });

    console.log(results.summary);

    assert.ok(results.f1 >= 0.85, `F1 ${results.f1} below 0.85 minimum`);
    assert.ok(results.precision >= 0.90, `Precision ${results.precision} below 0.90 minimum`);
    assert.ok(results.falsePositiveRate <= 0.05, `FP rate ${results.falsePositiveRate} above 5% maximum`);
  });
});
