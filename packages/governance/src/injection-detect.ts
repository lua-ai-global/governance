/**
 * Prompt Injection Detection — zero-dependency, pattern-based.
 *
 * Detects common prompt injection patterns in agent inputs.
 * Pattern definitions are in injection-patterns.ts.
 *
 * @example
 * ```ts
 * import { detectInjection, createInjectionGuard } from '@lua-ai-global/governance/injection-detect';
 *
 * const result = detectInjection('Ignore previous instructions...');
 * // { detected: true, score: 0.85, patterns: ['instruction_override'], ... }
 *
 * const guard = createInjectionGuard({ threshold: 0.5 });
 * gov.addRule(guard);
 * ```
 */

import { BUILTIN_PATTERNS } from "./injection-patterns.js";

// ─── Types ──────────────────────────────────────────────────────

export interface InjectionPattern {
  id: string;
  category: InjectionCategory;
  pattern: RegExp;
  weight: number;
  description: string;
}

export type InjectionCategory =
  | "instruction_override"
  | "role_manipulation"
  | "context_escape"
  | "data_exfiltration"
  | "encoding_attack"
  | "social_engineering"
  | "obfuscation";

export interface InjectionResult {
  detected: boolean;
  score: number;
  patterns: string[];
  categories: InjectionCategory[];
  summary: string;
  inputLength: number;
}

export interface InjectionDetectorConfig {
  threshold?: number;
  customPatterns?: InjectionPattern[];
  skipCategories?: InjectionCategory[];
}

// ─── Detection Engine ───────────────────────────────────────────

/** Strip zero-width characters and normalize Unicode for consistent matching */
function normalizeInput(input: string): string {
  // Remove zero-width characters (U+200B, U+200C, U+200D, U+FEFF, U+00AD)
  const stripped = input.replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g, "");
  // Normalize Unicode to NFC form
  return stripped.normalize("NFC");
}

/** Base64 regex: 16+ base64 chars with optional padding, not a common word */
const BASE64_RE = /[A-Za-z0-9+/]{16,}={0,2}/g;

/** Try to decode base64 strings in input; returns decoded text or null */
function tryDecodeBase64(encoded: string): string | null {
  try {
    const decoded = atob(encoded);
    // Only accept if result is printable ASCII/UTF-8
    if (/^[\x20-\x7E\t\n\r]+$/.test(decoded) && decoded.length >= 4) {
      return decoded;
    }
  } catch { /* not valid base64 */ }
  return null;
}

/**
 * Detect prompt injection patterns in text input.
 * Returns a score from 0 (no injection) to 1 (certain injection).
 *
 * Note: This is a heuristic pattern matcher, not an LLM classifier.
 * It catches known syntactic patterns but cannot detect novel semantic attacks.
 * For high-security deployments, layer this with an LLM-based classifier.
 */
export function detectInjection(
  input: string,
  config: InjectionDetectorConfig = {},
): InjectionResult {
  const threshold = config.threshold ?? 0.5;
  const skipCategories = new Set(config.skipCategories ?? []);

  const allPatterns = [
    ...BUILTIN_PATTERNS,
    ...(config.customPatterns ?? []),
  ].filter((p) => !skipCategories.has(p.category));

  const normalized = normalizeInput(input);
  const matchedPatterns: string[] = [];
  const matchedCategories = new Set<InjectionCategory>();
  let maxWeight = 0;

  // Scan the original input
  for (const pattern of allPatterns) {
    if (pattern.pattern.test(normalized)) {
      matchedPatterns.push(pattern.id);
      matchedCategories.add(pattern.category);
      if (pattern.weight > maxWeight) maxWeight = pattern.weight;
    }
  }

  // Decode any base64 strings and scan the decoded content too
  const b64Matches = normalized.match(BASE64_RE) ?? [];
  for (const b64 of b64Matches) {
    const decoded = tryDecodeBase64(b64);
    if (!decoded) continue;
    for (const pattern of allPatterns) {
      if (pattern.pattern.test(decoded) && !matchedPatterns.includes(pattern.id + ":decoded")) {
        matchedPatterns.push(pattern.id + ":decoded");
        matchedCategories.add(pattern.category);
        // Boost weight for encoded attacks — deliberate obfuscation
        const boosted = Math.min(1, pattern.weight + 0.1);
        if (boosted > maxWeight) maxWeight = boosted;
      }
    }
  }

  // Score = highest weight + boosts for multiple matches/categories
  const additionalBoost = matchedPatterns.length > 1
    ? Math.min(0.1, (matchedPatterns.length - 1) * 0.02)
    : 0;
  const categoryBoost = matchedCategories.size > 1
    ? Math.min(0.1, (matchedCategories.size - 1) * 0.03)
    : 0;

  const score = Math.min(1, maxWeight + additionalBoost + categoryBoost);
  const detected = score >= threshold;
  const categories = Array.from(matchedCategories);

  let summary: string;
  if (!detected) summary = "No injection detected";
  else if (score >= 0.8) summary = `High-confidence injection attempt: ${categories.join(", ")}`;
  else if (score >= 0.5) summary = `Possible injection attempt: ${categories.join(", ")}`;
  else summary = `Low-confidence injection signals: ${categories.join(", ")}`;

  return {
    detected,
    score: Math.round(score * 100) / 100,
    patterns: matchedPatterns,
    categories,
    summary,
    inputLength: input.length,
  };
}

// ─── Policy Integration ─────────────────────────────────────────

/**
 * Create a policy rule that blocks actions containing prompt injection.
 * Examines `ctx.input` for injection patterns.
 */
export function createInjectionGuard(config?: InjectionDetectorConfig & {
  priority?: number;
}): import("./policy").PolicyRule {
  const threshold = config?.threshold ?? 0.5;
  const priority = config?.priority ?? 110;

  return {
    id: "injection-guard",
    name: "Prompt Injection Guard",
    condition: {
      type: "custom",
      evaluate: (ctx) => {
        if (!ctx.input) return false;
        const strings = extractStrings(ctx.input);
        for (const str of strings) {
          const result = detectInjection(str, config);
          if (result.detected) return true;
        }
        return false;
      },
    },
    outcome: "block",
    reason: `Prompt injection detected (threshold: ${threshold})`,
    priority,
    enabled: true,
  };
}

/** Extract all string values from a nested object. */
function extractStrings(obj: Record<string, unknown>): string[] {
  const strings: string[] = [];
  function walk(value: unknown): void {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  }
  walk(obj);
  // Also test concatenation of all fields to catch cross-field injection splitting
  if (strings.length > 1) {
    strings.push(strings.join(" "));
  }
  return strings;
}

/** Get all built-in injection patterns. */
export function getBuiltinPatterns(): InjectionPattern[] {
  return [...BUILTIN_PATTERNS];
}
