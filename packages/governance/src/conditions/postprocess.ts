/**
 * Postprocess condition evaluators — run after agent execution.
 * Output length, output pattern, and sensitive data filtering.
 */

import type { EnforcementContext } from "../policy.js";
import { getSensitivePatterns } from "./sensitive-patterns.js";

/** Check if output exceeds length limits */
export function evaluateOutputLength(
  ctx: EnforcementContext,
  maxChars?: number,
  maxTokens?: number,
): boolean {
  if (!ctx.outputText) return false;

  if (maxChars !== undefined && ctx.outputText.length > maxChars) return true;
  if (maxTokens !== undefined) {
    const count = ctx.outputTokenCount ?? Math.ceil(ctx.outputText.length / 4);
    if (count > maxTokens) return true;
  }
  return false;
}

/** Check if output matches a regex pattern (e.g., secrets, API keys) */
export function evaluateOutputPattern(
  ctx: EnforcementContext,
  pattern: string,
  flags?: string,
): boolean {
  if (!ctx.outputText) return false;

  const regex = new RegExp(pattern, flags);
  return regex.test(ctx.outputText);
}

/** Scan output for sensitive data using built-in or custom patterns */
export function evaluateSensitiveDataFilter(
  ctx: EnforcementContext,
  patternIds?: string[],
): boolean {
  if (!ctx.outputText) return false;

  const patterns = getSensitivePatterns(patternIds);
  return patterns.some((p) => p.pattern.test(ctx.outputText!));
}
