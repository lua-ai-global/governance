/**
 * Agent Governance Benchmark — Core Types
 *
 * Multi-axis labeled samples. Each attack sample has independent labels
 * across vector, mechanism, objective, and target axes plus modifiers.
 * Benign samples have a benign category.
 */

import type { AttackVector, AttackMechanism, AttackObjective, AttackTarget, AttackModifier, BenignCategory } from "./taxonomy.js";

/** A single benchmark sample */
export interface BenchmarkSample {
  /** Stable ID: AGB-XXXXX */
  id: string;
  /** The input text to classify */
  text: string;
  /** Ground truth: is this an injection attempt? */
  label: "injection" | "benign";
  /** Dataset split */
  split: "train" | "validation" | "test";
  /** Data source */
  source: string;

  // ─── Attack labels (only for label === "injection") ─────
  /** How the attack enters the system */
  vector?: AttackVector;
  /** What technique the attack uses */
  mechanism?: AttackMechanism;
  /** What the attacker wants to achieve */
  objective?: AttackObjective;
  /** What component is being attacked */
  target?: AttackTarget;
  /** Additional modifiers */
  modifiers?: AttackModifier[];
  /** Severity */
  severity?: "critical" | "high" | "medium" | "low";

  // ─── Benign labels (only for label === "benign") ────────
  /** Why this benign sample exists (what FP pattern it tests) */
  benignCategory?: BenignCategory;

  /** Human-readable description */
  description?: string;
}

/** Result from a detector being benchmarked */
export interface DetectorResult {
  detected: boolean;
  score: number;
}

/** Function signature for a detector under test */
export type DetectorFn = (input: string) => DetectorResult | Promise<DetectorResult>;

/** Full benchmark dataset */
export interface BenchmarkDataset {
  name: string;
  version: string;
  description: string;
  license: string;
  created: string;
  taxonomy_version: string;
  stats: {
    total: number;
    injections: number;
    benign: number;
    splits: { train: number; validation: number; test: number };
    byVector: Record<string, number>;
    byMechanism: Record<string, number>;
    byObjective: Record<string, number>;
    byTarget: Record<string, number>;
    byBenignCategory: Record<string, number>;
  };
  samples: BenchmarkSample[];
}

/** Benchmark evaluation results */
export interface BenchmarkResults {
  detector: string;
  split: string;
  total: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  latencyMs: number;
  /** Recall broken down by each axis */
  recallByVector: Record<string, number>;
  recallByMechanism: Record<string, number>;
  recallByObjective: Record<string, number>;
  recallByTarget: Record<string, number>;
  /** FP rate broken down by benign category */
  fpByBenignCategory: Record<string, number>;
  failures: Array<{
    id: string;
    text: string;
    expected: string;
    got: string;
    score: number;
    mechanism?: string;
    objective?: string;
    benignCategory?: string;
  }>;
}
