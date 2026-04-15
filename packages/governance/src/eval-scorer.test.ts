import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEvalAdjustments, applyEvalAdjustments } from "./eval-scorer";
import type { EvalResult } from "./eval-types";
import type { DimensionResult } from "./types";

function mkResult(metrics: { name: string; score: number }[]): EvalResult {
  return {
    traceId: "t",
    agentId: "a",
    metrics: metrics.map((m) => ({ ...m })),
    evaluatedAt: new Date().toISOString(),
  };
}

describe("computeEvalAdjustments", () => {
  it("returns empty assessment for no results", () => {
    const a = computeEvalAdjustments({ results: [] });
    assert.equal(a.adjustments.length, 0);
    assert.equal(a.resultsAnalyzed, 0);
    assert.equal(a.overallQuality, 0);
  });

  it("rewards high scores with positive adjustments", () => {
    const a = computeEvalAdjustments({
      results: [mkResult([{ name: "safety_compliance", score: 1.0 }])],
    });
    const guardrails = a.adjustments.find((x) => x.dimension === "guardrails");
    assert.ok(guardrails && guardrails.adjustment > 0);
  });

  it("penalises low scores with negative adjustments", () => {
    const a = computeEvalAdjustments({
      results: [mkResult([{ name: "safety_compliance", score: 0.1 }])],
    });
    const guardrails = a.adjustments.find((x) => x.dimension === "guardrails");
    assert.ok(guardrails && guardrails.adjustment < 0);
  });

  it("clamps adjustments to ±20 per dimension", () => {
    const a = computeEvalAdjustments({
      results: Array.from({ length: 20 }, () => mkResult([{ name: "safety_compliance", score: 0 }])),
    });
    for (const adj of a.adjustments) {
      assert.ok(adj.adjustment >= -20 && adj.adjustment <= 20);
    }
  });

  it("applyEvalAdjustments respects dimension boundaries (0..100)", () => {
    const base: DimensionResult[] = [
      { dimension: "guardrails", score: 95, weight: 1.3, evidence: {} },
      { dimension: "compliance", score: 5, weight: 1.0, evidence: {} },
    ];
    const adjusted = applyEvalAdjustments(base, [
      { dimension: "guardrails", adjustment: 20, evidence: {} },
      { dimension: "compliance", adjustment: -20, evidence: {} },
    ]);
    const g = adjusted.find((d) => d.dimension === "guardrails");
    const c = adjusted.find((d) => d.dimension === "compliance");
    assert.equal(g!.score, 100, "should clamp at 100");
    assert.equal(c!.score, 0, "should clamp at 0");
  });
});
