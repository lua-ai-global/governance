/**
 * Masking helpers — redact sensitive data instead of blocking.
 *
 * Used by the policy engine when a rule's outcome is "mask".
 * Applies the same detection patterns as the condition evaluators
 * but replaces matched content with [REDACTED].
 */

import { getSensitivePatterns } from "./conditions/sensitive-patterns.js";

const REDACTED = "[REDACTED]";

/**
 * Mask sensitive data detected by the built-in sensitive_data_filter patterns.
 * Returns the text with all matches replaced by [REDACTED].
 */
export function maskSensitiveData(text: string, patternIds?: string[]): string {
  const patterns = getSensitivePatterns(patternIds);
  let result = text;
  for (const p of patterns) {
    // Clone with global flag to replace all occurrences
    const global = new RegExp(p.pattern.source, p.pattern.flags.includes("g") ? p.pattern.flags : p.pattern.flags + "g");
    result = result.replace(global, REDACTED);
  }
  return result;
}

/**
 * Mask text matching a custom regex pattern.
 * Used for output_pattern / input_pattern conditions with mask outcome.
 */
export function maskPattern(text: string, pattern: string, flags?: string): string {
  const f = flags ?? "";
  const global = new RegExp(pattern, f.includes("g") ? f : f + "g");
  return text.replace(global, REDACTED);
}

/**
 * Mask blocklisted terms in text.
 * Used for blocklist condition with mask outcome.
 */
export function maskBlocklistTerms(text: string, terms: string[]): string {
  let result = text;
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    result = result.replace(regex, REDACTED);
  }
  return result;
}
