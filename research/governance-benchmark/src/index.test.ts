import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TAXONOMY, VECTORS, MECHANISMS, OBJECTIVES, TARGETS, BENIGN_CATEGORIES,
  getAllVectors, getAllMechanisms, getAllObjectives, getAllTargets, getAllBenignCategories,
  generateDataset,
} from "./index";
import { runBenchmark, formatResults } from "./runner";

describe("Agent Governance Benchmark", () => {
  describe("taxonomy", () => {
    it("has 8 attack vectors", () => assert.equal(VECTORS.length, 8));
    it("has 9 attack mechanisms", () => assert.equal(MECHANISMS.length, 9));
    it("has 8 attack objectives", () => assert.equal(OBJECTIVES.length, 8));
    it("has 7 attack targets", () => assert.equal(TARGETS.length, 7));
    it("has 12 benign categories", () => assert.equal(BENIGN_CATEGORIES.length, 12));

    it("all vector IDs are unique", () => {
      const ids = getAllVectors();
      assert.equal(ids.length, new Set(ids).size);
    });

    it("all mechanism IDs are unique", () => {
      const ids = getAllMechanisms();
      assert.equal(ids.length, new Set(ids).size);
    });

    it("includes agent-specific vectors", () => {
      const ids = getAllVectors();
      assert.ok(ids.includes("agent_message"));
      assert.ok(ids.includes("mcp_metadata"));
      assert.ok(ids.includes("memory_state"));
      assert.ok(ids.includes("downstream_output"));
    });

    it("includes agent-specific mechanisms", () => {
      const ids = getAllMechanisms();
      assert.ok(ids.includes("delegation_forgery"));
      assert.ok(ids.includes("persistence_install"));
      assert.ok(ids.includes("conditional_trigger"));
    });

    it("includes agent-specific objectives", () => {
      const ids = getAllObjectives();
      assert.ok(ids.includes("privilege_escalation"));
      assert.ok(ids.includes("downstream_poisoning"));
      assert.ok(ids.includes("resource_exhaustion"));
      assert.ok(ids.includes("boundary_violation"));
    });

    it("includes evaluator as a target", () => {
      assert.ok(getAllTargets().includes("evaluator"));
    });

    it("includes structured_operations benign category", () => {
      assert.ok(getAllBenignCategories().includes("structured_operations"));
    });

    it("taxonomy metadata is consistent", () => {
      assert.equal(TAXONOMY.axes.vectors.length, 8);
      assert.equal(TAXONOMY.axes.mechanisms.length, 9);
      assert.equal(TAXONOMY.axes.objectives.length, 8);
      assert.equal(TAXONOMY.axes.targets.length, 7);
      assert.equal(TAXONOMY.modifiers.length, 5);
    });
  });

  describe("generator", () => {
    it("generates target number of samples", () => {
      const samples = generateDataset({ target: 1000 });
      assert.ok(samples.length >= 900, `Expected ~1000, got ${samples.length}`);
    });

    it("maintains ~55/45 attack/benign split", () => {
      const samples = generateDataset({ target: 1000 });
      const attacks = samples.filter((s) => s.label === "injection").length;
      const ratio = attacks / samples.length;
      assert.ok(ratio >= 0.45 && ratio <= 0.65, `Attack ratio ${ratio} out of range`);
    });

    it("attack samples have multi-axis labels", () => {
      const samples = generateDataset({ target: 500 });
      const attacks = samples.filter((s) => s.label === "injection");
      for (const atk of attacks.slice(0, 20)) {
        assert.ok(atk.vector, `Missing vector on ${atk.id}`);
        assert.ok(atk.mechanism, `Missing mechanism on ${atk.id}`);
        assert.ok(atk.objective, `Missing objective on ${atk.id}`);
        assert.ok(atk.target, `Missing target on ${atk.id}`);
      }
    });

    it("benign samples have benign category", () => {
      const samples = generateDataset({ target: 500 });
      const benign = samples.filter((s) => s.label === "benign");
      for (const b of benign.slice(0, 20)) {
        assert.ok(b.benignCategory, `Missing benignCategory on ${b.id}`);
      }
    });

    it("covers multiple vectors", () => {
      const samples = generateDataset({ target: 5000 });
      const vectors = new Set(samples.filter((s) => s.vector).map((s) => s.vector));
      assert.ok(vectors.size >= 4, `Only ${vectors.size} vectors covered`);
    });

    it("covers multiple mechanisms", () => {
      const samples = generateDataset({ target: 5000 });
      const mechs = new Set(samples.filter((s) => s.mechanism).map((s) => s.mechanism));
      assert.ok(mechs.size >= 6, `Only ${mechs.size} mechanisms covered`);
    });

    it("covers multiple objectives", () => {
      const samples = generateDataset({ target: 5000 });
      const objs = new Set(samples.filter((s) => s.objective).map((s) => s.objective));
      assert.ok(objs.size >= 5, `Only ${objs.size} objectives covered`);
    });

    it("assigns train/validation/test splits", () => {
      const samples = generateDataset({ target: 1000 });
      const splits = new Set(samples.map((s) => s.split));
      assert.ok(splits.has("train"));
      assert.ok(splits.has("validation"));
      assert.ok(splits.has("test"));
    });

    it("is deterministic with same seed", () => {
      const a = generateDataset({ target: 100, seed: 42 });
      const b = generateDataset({ target: 100, seed: 42 });
      assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id));
      assert.deepEqual(a.map((s) => s.text), b.map((s) => s.text));
    });

    it("all IDs are unique", () => {
      const samples = generateDataset({ target: 1000 });
      const ids = samples.map((s) => s.id);
      assert.equal(ids.length, new Set(ids).size);
    });

    it("can generate 10K+ samples", () => {
      const samples = generateDataset({ target: 10000 });
      assert.ok(samples.length >= 9000, `Expected ~10K, got ${samples.length}`);
    });
  });

  describe("runner", () => {
    it("runs detector and reports per-axis metrics", async () => {
      const samples = generateDataset({ target: 200 });
      const test = samples.filter((s) => s.split === "test");

      const results = await runBenchmark(
        test,
        (input) => ({ detected: input.toLowerCase().includes("ignore"), score: 0.9 }),
        "dummy",
      );

      assert.ok(results.precision >= 0);
      assert.ok(results.recall >= 0);
      assert.ok(Object.keys(results.recallByMechanism).length > 0);
      assert.ok(Object.keys(results.recallByObjective).length > 0);
    });

    it("formatResults produces readable output", async () => {
      const samples = generateDataset({ target: 100 });
      const results = await runBenchmark(
        samples.filter((s) => s.split === "test"),
        () => ({ detected: false, score: 0 }),
        "null",
      );
      const text = formatResults(results);
      assert.ok(text.includes("Agent Governance Benchmark"));
      assert.ok(text.includes("Recall by Mechanism"));
    });
  });
});
