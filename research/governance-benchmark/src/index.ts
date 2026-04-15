/**
 * governance-sdk-benchmark
 *
 * Agent Governance Benchmark (AGB) — multi-axis evaluation
 * dataset for AI agent injection detection.
 *
 * 10K+ samples labeled across 4 independent axes:
 * vector (8) × mechanism (9) × objective (8) × target (7)
 *
 * Plus 12 benign categories for false positive testing.
 */

export {
  TAXONOMY, VECTORS, MECHANISMS, OBJECTIVES, TARGETS, BENIGN_CATEGORIES,
  getAllVectors, getAllMechanisms, getAllObjectives, getAllTargets, getAllBenignCategories,
} from "./taxonomy.js";
export type {
  AttackVector, AttackMechanism, AttackObjective, AttackTarget, AttackModifier,
  AttackLabel, BenignCategory, VectorDef, MechanismDef, ObjectiveDef, TargetDef, BenignCategoryDef,
} from "./taxonomy.js";

export { generateDataset } from "./generator.js";
export type { GeneratorConfig } from "./generator.js";

export { runBenchmark, formatResults } from "./runner.js";
export type { BenchmarkSample, BenchmarkResults, BenchmarkDataset, DetectorFn, DetectorResult } from "./types.js";
