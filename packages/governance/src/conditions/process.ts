/**
 * Process condition evaluators — run during agent execution.
 * Network allowlist, scope boundary, cost budget, concurrent limit.
 */

import type { EnforcementContext } from "../policy.js";

/** Check if target URL domain is in the allowlist */
export function evaluateNetworkAllowlist(
  ctx: EnforcementContext,
  allowedDomains: string[],
): boolean {
  if (!ctx.targetUrl) return false;

  let hostname: string;
  try {
    hostname = new URL(ctx.targetUrl).hostname;
  } catch {
    // If it's not a valid URL, treat the raw string as a hostname
    hostname = ctx.targetUrl;
  }

  const lower = hostname.toLowerCase();
  return !allowedDomains.some((d) => {
    const domain = d.toLowerCase();
    return lower === domain || lower.endsWith(`.${domain}`);
  });
}

/** Check if target path violates scope boundaries */
export function evaluateScopeBoundary(
  ctx: EnforcementContext,
  allowedPaths?: string[],
  blockedPaths?: string[],
): boolean {
  if (!ctx.targetPath) return false;
  const p = ctx.targetPath;

  if (blockedPaths && blockedPaths.length > 0) {
    if (blockedPaths.some((bp) => pathMatches(p, bp))) return true;
  }

  if (allowedPaths && allowedPaths.length > 0) {
    if (!allowedPaths.some((ap) => pathMatches(p, ap))) return true;
  }

  return false;
}

/** Check if session cost exceeds budget */
export function evaluateCostBudget(
  ctx: EnforcementContext,
  maxCost: number,
): boolean {
  return (ctx.sessionCost ?? 0) > maxCost;
}

/** Check if concurrent tool count exceeds limit */
export function evaluateConcurrentLimit(
  ctx: EnforcementContext,
  maxConcurrent: number,
): boolean {
  return (ctx.concurrentCount ?? 0) > maxConcurrent;
}

/** Simple path matching — supports trailing wildcard (*) */
function pathMatches(target: string, pattern: string): boolean {
  if (pattern.endsWith("/*") || pattern.endsWith("/**")) {
    const prefix = pattern.replace(/\/\*{1,2}$/, "");
    return target === prefix || target.startsWith(prefix + "/");
  }
  return target === pattern;
}
