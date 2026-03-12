/**
 * Preprocess condition evaluators — run before agent processing.
 * Blocklist, input length, and input pattern matching.
 */

import type { EnforcementContext } from "../policy.js";

/** Check if input contains any blocked terms */
export function evaluateBlocklist(
  ctx: EnforcementContext,
  terms: string[],
  caseSensitive?: boolean,
): boolean {
  const inputStr = getInputString(ctx);
  if (!inputStr) return false;

  const haystack = caseSensitive ? inputStr : inputStr.toLowerCase();
  return terms.some((term) => {
    const needle = caseSensitive ? term : term.toLowerCase();
    return haystack.includes(needle);
  });
}

/** Check if input exceeds length limits */
export function evaluateInputLength(
  ctx: EnforcementContext,
  maxChars?: number,
  maxTokens?: number,
): boolean {
  const inputStr = getInputString(ctx);
  if (!inputStr) return false;

  if (maxChars !== undefined && inputStr.length > maxChars) return true;
  if (maxTokens !== undefined) {
    // Rough estimate: ~4 chars per token
    const estimated = Math.ceil(inputStr.length / 4);
    if (estimated > maxTokens) return true;
  }
  return false;
}

/** Check if input matches a regex pattern */
export function evaluateInputPattern(
  ctx: EnforcementContext,
  pattern: string,
  flags?: string,
): boolean {
  const inputStr = getInputString(ctx);
  if (!inputStr) return false;

  const regex = new RegExp(pattern, flags);
  return regex.test(inputStr);
}

/** Extract a string representation of the input for scanning */
function getInputString(ctx: EnforcementContext): string | null {
  if (!ctx.input) return null;
  return typeof ctx.input === "string"
    ? ctx.input
    : JSON.stringify(ctx.input);
}
