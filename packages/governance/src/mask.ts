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
 * Patterns that match specific token formats (sk-, ghp_, AKIA, etc.) should
 * run before broad patterns (aws_secret) to avoid partial matches.
 */
const SPECIFIC_FIRST = new Set([
  "generic_sk", "generic_pk", "anthropic_key", "stripe_key", "sendgrid_key",
  "github_pat", "github_oauth", "github_app", "google_api_key", "aws_key",
  "slack_token", "jwt", "private_key",
  "postgres_uri", "mysql_uri", "mongodb_uri", "redis_uri",
]);

/**
 * System prompt leak patterns only match trigger phrases. For masking,
 * we redact from the trigger to the end of the sentence/line.
 */
const PROMPT_LEAK_IDS = new Set(["system_prompt_leak", "hidden_instructions", "never_reveal"]);

/**
 * Mask sensitive data detected by the built-in sensitive_data_filter patterns.
 * Returns the text with all matches replaced by [REDACTED].
 */
export function maskSensitiveData(text: string, patternIds?: string[]): string {
  const patterns = getSensitivePatterns(patternIds);

  // Sort: specific token patterns first, broad patterns last
  const sorted = [...patterns].sort((a, b) => {
    const aSpecific = SPECIFIC_FIRST.has(a.id) ? 0 : 1;
    const bSpecific = SPECIFIC_FIRST.has(b.id) ? 0 : 1;
    return aSpecific - bSpecific;
  });

  let result = text;
  for (const p of sorted) {
    if (PROMPT_LEAK_IDS.has(p.id)) {
      // For prompt leak patterns, redact from match to end of sentence/line
      const extended = new RegExp(
        p.pattern.source + "[^.\\n]*",
        p.pattern.flags.includes("g") ? p.pattern.flags : p.pattern.flags + "g",
      );
      result = result.replace(extended, REDACTED);
    } else {
      const global = new RegExp(
        p.pattern.source,
        p.pattern.flags.includes("g") ? p.pattern.flags : p.pattern.flags + "g",
      );
      result = result.replace(global, REDACTED);
    }
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
