import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setInjectionClassifier, getInjectionClassifier,
  clearInjectionClassifier, hasInjectionClassifier,
  hybridDetect,
} from "./injection-classifier";

describe("Injection Classifier Interface", () => {
  afterEach(() => clearInjectionClassifier());

  it("starts with no classifier", () => {
    assert.equal(hasInjectionClassifier(), false);
    assert.equal(getInjectionClassifier(), null);
  });

  it("registers and retrieves a classifier", () => {
    const classifier = {
      classify: async () => ({ detected: false, score: 0, categories: [], latencyMs: 1 }),
    };
    setInjectionClassifier(classifier);
    assert.equal(hasInjectionClassifier(), true);
    assert.equal(getInjectionClassifier(), classifier);
  });

  it("clears classifier", () => {
    setInjectionClassifier({
      classify: async () => ({ detected: false, score: 0, categories: [], latencyMs: 0 }),
    });
    clearInjectionClassifier();
    assert.equal(hasInjectionClassifier(), false);
  });

  describe("hybridDetect", () => {
    it("returns regex-only when no classifier registered", async () => {
      const result = await hybridDetect("test input", 0.7, ["instruction_override"], 0.5);
      assert.equal(result.detected, true);
      assert.equal(result.regexScore, 0.7);
      assert.equal(result.mlScore, null);
      assert.equal(result.finalScore, 0.7);
      assert.equal(result.source, "regex");
    });

    it("combines regex and ML scores (regex wins)", async () => {
      setInjectionClassifier({
        classify: async () => ({ detected: true, score: 0.6, categories: ["role_manipulation"], latencyMs: 50 }),
      });

      const result = await hybridDetect("test", 0.8, ["instruction_override"], 0.5);
      assert.equal(result.detected, true);
      assert.equal(result.regexScore, 0.8);
      assert.equal(result.mlScore, 0.6);
      assert.equal(result.finalScore, 0.8); // regex > ml * 0.9
      assert.equal(result.source, "hybrid");
    });

    it("combines regex and ML scores (ML wins)", async () => {
      setInjectionClassifier({
        classify: async () => ({ detected: true, score: 0.95, categories: ["novel_attack"], latencyMs: 30 }),
      });

      const result = await hybridDetect("test", 0.3, [], 0.5);
      assert.equal(result.detected, true);
      assert.equal(result.finalScore, 0.95 * 0.9); // ML * 0.9 > regex
      assert.equal(result.source, "ml");
      assert.ok(result.categories.includes("novel_attack"));
    });

    it("falls back to regex when ML classifier fails", async () => {
      setInjectionClassifier({
        classify: async () => { throw new Error("Model offline"); },
      });

      const result = await hybridDetect("test", 0.6, ["encoding_attack"], 0.5);
      assert.equal(result.detected, true);
      assert.equal(result.source, "regex");
      assert.equal(result.mlScore, null);
    });

    it("merges categories from both sources", async () => {
      setInjectionClassifier({
        classify: async () => ({ detected: true, score: 0.7, categories: ["social_engineering"], latencyMs: 10 }),
      });

      const result = await hybridDetect("test", 0.8, ["instruction_override"], 0.5);
      assert.ok(result.categories.includes("instruction_override"));
      assert.ok(result.categories.includes("social_engineering"));
    });

    it("respects threshold", async () => {
      const result = await hybridDetect("test", 0.3, [], 0.5);
      assert.equal(result.detected, false);
    });

    it("reports ML latency", async () => {
      setInjectionClassifier({
        classify: async () => ({ detected: false, score: 0.1, categories: [], latencyMs: 42 }),
      });

      const result = await hybridDetect("test", 0.1, [], 0.5);
      assert.equal(result.mlLatencyMs, 42);
    });
  });
});
