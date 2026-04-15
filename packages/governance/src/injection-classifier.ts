/**
 * governance-sdk — ML Injection Detection Interface
 *
 * Defines a pluggable classifier interface for ML-based injection detection.
 * The OSS SDK ships the interface; commercial packages provide implementations.
 *
 * **Integration with the synchronous policy engine:**
 * The core policy engine is synchronous by design (zero-dep, no hidden I/O).
 * Async ML classifiers cannot run inside `gov.enforce()`. Instead:
 *
 *   1. In your host wrapper, call `hybridDetect(input, { threshold })` on
 *      the user prompt. That invokes the classifier + regex detector and
 *      returns a merged score.
 *   2. Populate `ctx.mlInjectionScore` (and optionally
 *      `ctx.mlInjectionCategories`) on the `EnforcementContext`.
 *   3. Add `mlInjectionGuard({ threshold })` to your rule set. The sync
 *      evaluator reads the pre-computed score and blocks when it fires.
 *
 * This keeps the SDK fast and dependency-free while letting you layer any
 * ML detector (Lakera, Prompt-Guard-2 via Groq, a local ONNX DeBERTa, …)
 * into the enforcement path.
 *
 * @example
 * ```ts
 * import { setInjectionClassifier, getInjectionClassifier } from 'governance-sdk/injection-classifier';
 *
 * // Register a classifier (e.g., from governance-sdk-ml)
 * setInjectionClassifier({
 *   classify: async (input) => ({
 *     detected: true,
 *     score: 0.92,
 *     categories: ['instruction_override'],
 *     latencyMs: 45,
 *   }),
 * });
 *
 * // Or use any third-party classifier
 * setInjectionClassifier({
 *   classify: async (input) => {
 *     const res = await fetch('https://api.lakera.ai/v1/guard', { ... });
 *     const data = await res.json();
 *     return { detected: data.flagged, score: data.score, categories: data.categories, latencyMs: data.latency };
 *   },
 * });
 * ```
 */

// ─── Types ───────────────────────────────────────────────────

/** Result from an ML injection classifier */
export interface ClassifierResult {
  detected: boolean;
  score: number;
  categories: string[];
  latencyMs: number;
}

/** ML injection classifier interface — implement to plug in a classifier */
export interface InjectionClassifier {
  classify(input: string): Promise<ClassifierResult>;
}

/** Combined result from hybrid (regex + ML) detection */
export interface HybridDetectionResult {
  detected: boolean;
  regexScore: number;
  mlScore: number | null;
  finalScore: number;
  source: "regex" | "ml" | "hybrid";
  mlLatencyMs: number | null;
  categories: string[];
}

// ─── Global Classifier Registry ─────────────────────────────

let globalClassifier: InjectionClassifier | null = null;

/** Register a global ML injection classifier */
export function setInjectionClassifier(classifier: InjectionClassifier): void {
  globalClassifier = classifier;
}

/** Get the registered ML injection classifier (or null if none) */
export function getInjectionClassifier(): InjectionClassifier | null {
  return globalClassifier;
}

/** Clear the registered classifier */
export function clearInjectionClassifier(): void {
  globalClassifier = null;
}

/** Check if an ML classifier is registered */
export function hasInjectionClassifier(): boolean {
  return globalClassifier !== null;
}

// ─── Hybrid Detection ───────────────────────────────────────

/**
 * Run hybrid detection combining regex and ML scores.
 * If no ML classifier is registered, falls back to regex-only.
 *
 * Scoring: FINAL = MAX(regexScore, mlScore * 0.9)
 * The 0.9 factor slightly discounts ML to prefer the deterministic signal
 * when both scores are similar.
 */
export async function hybridDetect(
  input: string,
  regexScore: number,
  regexCategories: string[],
  threshold: number,
): Promise<HybridDetectionResult> {
  if (!globalClassifier) {
    return {
      detected: regexScore >= threshold,
      regexScore,
      mlScore: null,
      finalScore: regexScore,
      source: "regex",
      mlLatencyMs: null,
      categories: regexCategories,
    };
  }

  try {
    const mlResult = await globalClassifier.classify(input);
    const discountedMl = mlResult.score * 0.9;
    const finalScore = Math.max(regexScore, discountedMl);
    const allCategories = [...new Set([...regexCategories, ...mlResult.categories])];

    return {
      detected: finalScore >= threshold,
      regexScore,
      mlScore: mlResult.score,
      finalScore,
      source: regexScore >= discountedMl ? (mlResult.score > 0 ? "hybrid" : "regex") : "ml",
      mlLatencyMs: mlResult.latencyMs,
      categories: allCategories,
    };
  } catch {
    // ML classifier failed — fall back to regex
    return {
      detected: regexScore >= threshold,
      regexScore,
      mlScore: null,
      finalScore: regexScore,
      source: "regex",
      mlLatencyMs: null,
      categories: regexCategories,
    };
  }
}
