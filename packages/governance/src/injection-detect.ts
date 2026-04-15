/**
 * Prompt Injection Detection — zero-dependency, pattern-based.
 *
 * Detects common prompt injection patterns in agent inputs.
 * Pattern definitions are in injection-patterns.ts.
 *
 * @example
 * ```ts
 * import { detectInjection, createInjectionGuard } from 'governance-sdk/injection-detect';
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

/** Default max input length: 100KB */
const DEFAULT_MAX_INPUT_LENGTH = 100_000;

export interface InjectionDetectorConfig {
  threshold?: number;
  customPatterns?: InjectionPattern[];
  skipCategories?: InjectionCategory[];
  /** Maximum input length in characters. Inputs exceeding this are flagged as detected. Default: 100000 */
  maxInputLength?: number;
}

// ─── Detection Engine ───────────────────────────────────────────

/**
 * Strip zero-width characters and normalize Unicode to NFKC (compatibility +
 * canonical) so fullwidth, circled, superscript, and similar evasions collapse
 * to their ASCII form before pattern matching.
 */
function normalizeInput(input: string): string {
  // Remove zero-width characters (U+200B, U+200C, U+200D, U+FEFF, U+00AD, U+2060, U+180E)
  const stripped = input.replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g, "");
  // NFKC folds compatibility variants (fullwidth `Ｉ` → `I`, superscripts → digits, etc.)
  return stripped.normalize("NFKC");
}

/**
 * Map common leetspeak substitutions back to letters so attacks like
 * `1gn0r3 pr3v10us 1nstruct10ns` match the same patterns as `ignore
 * previous instructions`. We apply this as a **second pass** alongside
 * (not replacing) the normalised input, so a rule only needs to match
 * either form to fire. Conservative mapping — we keep common false-positive
 * digits (0=0, 1=1 in numeric context) intact if the surrounding token has
 * no alpha characters.
 */
const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  "$": "s",
  "!": "i",
  "|": "i",
};

export function deleetInput(input: string): string {
  // Walk token-by-token. A token is a run of non-whitespace. We only apply
  // leet mapping to tokens that already contain at least one alpha — that
  // way "payment of $99" stays as "$99" (not "say99") while "1gn0r3" gets
  // normalised to "ignore".
  return input
    .split(/(\s+)/)
    .map((tok) => {
      if (!/[a-zA-Z]/.test(tok)) return tok;
      let out = "";
      for (const ch of tok) out += LEET_MAP[ch] ?? ch;
      return out;
    })
    .join("");
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
  const maxLen = config.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
  if (input.length > maxLen) {
    return {
      detected: true,
      score: 1,
      patterns: ["input_too_large"],
      categories: ["system_prompt" as InjectionCategory],
      summary: `Input exceeds maximum length (${input.length} > ${maxLen})`,
      inputLength: input.length,
    };
  }

  const threshold = config.threshold ?? 0.5;
  const skipCategories = new Set(config.skipCategories ?? []);

  const allPatterns = [
    ...BUILTIN_PATTERNS,
    ...(config.customPatterns ?? []),
  ].filter((p) => !skipCategories.has(p.category));

  const normalized = normalizeInput(input);
  const deleeted = deleetInput(normalized);
  const matchedPatterns: string[] = [];
  const matchedCategories = new Set<InjectionCategory>();
  let maxWeight = 0;

  // Scan the normalised input first; fall back to the leet-folded form so
  // attacks like "1gn0r3 pr3v10us 1nstruct10ns" also fire.
  for (const pattern of allPatterns) {
    const matchedOriginal = pattern.pattern.test(normalized);
    const matchedLeet = !matchedOriginal && deleeted !== normalized && pattern.pattern.test(deleeted);
    if (matchedOriginal || matchedLeet) {
      const id = matchedLeet ? pattern.id + ":leet" : pattern.id;
      matchedPatterns.push(id);
      matchedCategories.add(pattern.category);
      // Leet matches get the same +0.1 nudge encoded attacks get — they are
      // deliberate obfuscation, so we rank them slightly higher than a plain
      // keyword hit.
      const weight = matchedLeet ? Math.min(1, pattern.weight + 0.1) : pattern.weight;
      if (weight > maxWeight) maxWeight = weight;
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
      type: "injection_guard",
      params: {
        threshold,
        skipCategories: config?.skipCategories ?? [],
      },
    },
    outcome: "block",
    reason: `Prompt injection detected (threshold: ${threshold})`,
    priority,
    enabled: true,
    stage: "preprocess" as const,
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
