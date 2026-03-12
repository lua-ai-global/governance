/**
 * Extended Policy Preset Builders
 *
 * Convenience functions for the 10 new condition types added with
 * the multi-stage policy engine. Each preset includes a default stage.
 */

import type { PolicyRule } from "./policy.js";

/** Block input containing any of the listed terms */
export function inputBlocklist(terms: string[], opts?: { caseSensitive?: boolean; reason?: string }): PolicyRule {
  return {
    id: `blocklist-${terms.slice(0, 3).join("-")}`,
    name: `Term blocklist: ${terms.slice(0, 5).join(", ")}${terms.length > 5 ? "..." : ""}`,
    condition: { type: "blocklist", params: { terms, caseSensitive: opts?.caseSensitive } },
    outcome: "block",
    reason: opts?.reason ?? `Input contains blocked term`,
    priority: 105,
    enabled: true,
    stage: "preprocess",
  };
}

/** Reject oversized inputs */
export function inputLength(maxChars: number, maxTokens?: number, reason?: string): PolicyRule {
  return {
    id: `input-length-${maxChars}`,
    name: `Input length limit: ${maxChars.toLocaleString()} chars`,
    condition: { type: "input_length", params: { maxChars, maxTokens } },
    outcome: "block",
    reason: reason ?? `Input exceeds length limit (${maxChars.toLocaleString()} chars)`,
    priority: 100,
    enabled: true,
    stage: "preprocess",
  };
}

/** Block input matching a regex pattern */
export function inputPattern(pattern: string, flags?: string, reason?: string): PolicyRule {
  return {
    id: `input-pattern-${pattern.slice(0, 20).replace(/[^a-z0-9]/gi, "")}`,
    name: `Input pattern: /${pattern}/`,
    condition: { type: "input_pattern", params: { pattern, flags } },
    outcome: "block",
    reason: reason ?? `Input matches blocked pattern`,
    priority: 95,
    enabled: true,
    stage: "preprocess",
  };
}

/** Only allow external requests to listed domains */
export function networkAllowlist(domains: string[], reason?: string): PolicyRule {
  return {
    id: `network-allowlist`,
    name: `Network allowlist: ${domains.join(", ")}`,
    condition: { type: "network_allowlist", params: { allowedDomains: domains } },
    outcome: "block",
    reason: reason ?? `Target domain not in allowlist`,
    priority: 85,
    enabled: true,
    stage: "process",
  };
}

/** Restrict file/resource access to allowed paths */
export function scopeBoundary(opts: { allowedPaths?: string[]; blockedPaths?: string[]; reason?: string }): PolicyRule {
  return {
    id: `scope-boundary`,
    name: `Scope boundary`,
    condition: { type: "scope_boundary", params: { allowedPaths: opts.allowedPaths, blockedPaths: opts.blockedPaths } },
    outcome: "block",
    reason: opts.reason ?? `Path outside allowed scope`,
    priority: 80,
    enabled: true,
    stage: "process",
  };
}

/** Cap monetary cost per session */
export function costBudget(maxCost: number, currency = "USD", reason?: string): PolicyRule {
  return {
    id: `cost-budget-${maxCost}`,
    name: `Cost budget: ${maxCost} ${currency}`,
    condition: { type: "cost_budget", params: { maxCost, currency } },
    outcome: "block",
    reason: reason ?? `Session cost exceeded budget (${maxCost} ${currency})`,
    priority: 65,
    enabled: true,
    stage: "process",
  };
}

/** Cap parallel tool executions */
export function concurrentLimit(max: number, reason?: string): PolicyRule {
  return {
    id: `concurrent-limit-${max}`,
    name: `Concurrency limit: ${max}`,
    condition: { type: "concurrent_limit", params: { maxConcurrent: max } },
    outcome: "block",
    reason: reason ?? `Concurrent execution limit exceeded (max ${max})`,
    priority: 55,
    enabled: true,
    stage: "process",
  };
}

/** Reject oversized outputs */
export function outputLength(maxChars: number, maxTokens?: number, reason?: string): PolicyRule {
  return {
    id: `output-length-${maxChars}`,
    name: `Output length limit: ${maxChars.toLocaleString()} chars`,
    condition: { type: "output_length", params: { maxChars, maxTokens } },
    outcome: "warn",
    reason: reason ?? `Output exceeds length limit (${maxChars.toLocaleString()} chars)`,
    priority: 75,
    enabled: true,
    stage: "postprocess",
  };
}

/** Detect patterns in output (API keys, tokens, etc.) */
export function outputPattern(pattern: string, flags?: string, reason?: string): PolicyRule {
  return {
    id: `output-pattern-${pattern.slice(0, 20).replace(/[^a-z0-9]/gi, "")}`,
    name: `Output pattern scan: /${pattern}/`,
    condition: { type: "output_pattern", params: { pattern, flags } },
    outcome: "block",
    reason: reason ?? `Output contains blocked pattern`,
    priority: 90,
    enabled: true,
    stage: "postprocess",
  };
}

/** Detect leaked credentials/keys using built-in pattern set */
export function sensitiveDataFilter(patterns?: string[], reason?: string): PolicyRule {
  return {
    id: `sensitive-data-filter`,
    name: `Sensitive data filter`,
    condition: { type: "sensitive_data_filter", params: { patterns } },
    outcome: "block",
    reason: reason ?? `Output contains sensitive data (credentials, keys, or secrets)`,
    priority: 95,
    enabled: true,
    stage: "postprocess",
  };
}
