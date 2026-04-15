/**
 * Policy Preset Builders
 *
 * Convenience functions that create common PolicyRule configurations.
 * Separated from the policy engine to keep files under 300 LOC.
 */

import type { PolicyRule, PolicyAction } from "./policy.js";

/**
 * Block specific tools from being called by any agent.
 *
 * @param tools - Array of tool names to block
 * @param reason - Optional custom reason message
 * @returns A PolicyRule with priority 100 that blocks matching tool_call actions
 *
 * @example
 * ```ts
 * const rule = blockTools(['shell_exec', 'rm_rf', 'database_drop']);
 * ```
 */
export function blockTools(tools: string[], reason?: string): PolicyRule {
  return {
    id: `block-tools-${tools.join("-")}`,
    name: `Block tools: ${tools.join(", ")}`,
    condition: { type: "tool_blocked", params: { tools } },
    outcome: "block",
    reason: reason ?? `Tool is on the blocked list: ${tools.join(", ")}`,
    priority: 100,
    enabled: true,
    stage: "process",
  };
}

/**
 * Only allow specific tools — block everything not on the list.
 *
 * @param tools - Array of tool names to allow (all others blocked)
 * @param reason - Optional custom reason message
 * @returns A PolicyRule with priority 90 that blocks unlisted tools
 *
 * @example
 * ```ts
 * const rule = allowOnlyTools(['web_search', 'email_read']);
 * ```
 */
export function allowOnlyTools(tools: string[], reason?: string): PolicyRule {
  return {
    id: `allow-only-tools`,
    name: `Allow only: ${tools.join(", ")}`,
    condition: { type: "tool_allowed", params: { tools } },
    outcome: "block",
    reason: reason ?? `Tool is not on the approved list`,
    priority: 90,
    enabled: true,
    stage: "process",
  };
}

/**
 * Require human approval for specific action types.
 * Uses the action_type condition with a require_approval outcome.
 *
 * @param actions - Action types that need human review (e.g., "payment", "external_request")
 * @param reason - Optional custom reason message
 * @returns A PolicyRule with outcome "require_approval"
 *
 * @example
 * ```ts
 * const rule = requireApproval(['payment', 'database_mutation']);
 * ```
 */
export function requireApproval(actions: PolicyAction[], reason?: string): PolicyRule {
  return {
    id: `require-approval-${actions.join("-")}`,
    name: `Require approval: ${actions.join(", ")}`,
    condition: { type: "action_type", params: { actions } },
    outcome: "require_approval",
    reason: reason ?? `Action requires human approval: ${actions.join(", ")}`,
    priority: 80,
    enabled: true,
    stage: "process",
  };
}

/**
 * Enforce a per-session token budget. Blocks when sessionTokensUsed exceeds maxTokens.
 *
 * @param maxTokens - Maximum tokens allowed per session
 * @returns A PolicyRule with priority 70 that blocks over-budget actions
 */
export function tokenBudget(maxTokens: number): PolicyRule {
  return {
    id: `token-budget-${maxTokens}`,
    name: `Token budget: ${maxTokens.toLocaleString()}`,
    condition: { type: "token_limit", params: { maxTokens } },
    outcome: "block",
    reason: `Session token budget exceeded (${maxTokens.toLocaleString()} max)`,
    priority: 70,
    enabled: true,
    stage: "process",
  };
}

/**
 * Rate-limit agent actions within a time window.
 *
 * **STATELESSNESS CONTRACT**: the SDK's policy engine is a thin client — it
 * does NOT track action counts internally. The `rate_limit` condition
 * reads `ctx.recentActionCount` from the enforcement context, which the
 * **host** is responsible for populating before calling `gov.enforce()`.
 *
 * This is deliberate: durable, distributed, race-free rate limiting belongs
 * in your API layer (Redis INCR, a rate-limit service, etc.), not in an
 * in-process SDK. If you need zero-config rate limiting and are okay with
 * per-process correctness only, wire up an in-memory counter in your
 * enforce wrapper — see governance-cloud/ for a reference.
 *
 * @param maxActions - Maximum actions allowed in the window
 * @param windowMs - Window duration in milliseconds
 * @returns A PolicyRule with priority 60 that blocks when `ctx.recentActionCount > maxActions`
 */
export function rateLimit(maxActions: number, windowMs: number): PolicyRule {
  return {
    id: `rate-limit-${maxActions}-${windowMs}`,
    name: `Rate limit: ${maxActions} per ${windowMs}ms`,
    condition: { type: "rate_limit", params: { maxActions, windowMs } },
    outcome: "block",
    reason: `Rate limit exceeded (${maxActions} actions per ${windowMs / 1000}s window)`,
    priority: 60,
    enabled: true,
    stage: "process",
  };
}

/**
 * Require a minimum governance level (0-4) for the agent to operate.
 *
 * @param minLevel - Minimum governance level (0=Unregistered, 4=Certified)
 * @returns A PolicyRule with priority 95 that blocks under-level agents
 */
export function requireLevel(minLevel: number): PolicyRule {
  return {
    id: `require-level-${minLevel}`,
    name: `Require governance level ${minLevel}+`,
    condition: { type: "agent_level", params: { minLevel } },
    outcome: "block",
    reason: `Agent governance level below required minimum (L${minLevel})`,
    priority: 95,
    enabled: true,
    stage: "process",
  };
}

/**
 * Require a cryptographically signed Ed25519 identity on every matching
 * action. The host (API layer) must verify the signature against its cert
 * vault BEFORE calling enforce() and set `ctx.identityVerified` and
 * `ctx.identityCapabilityMatch` accordingly.
 *
 * This is the one-click "agents must prove who they are" policy. Pairs with
 * governance-sdk/agent-identity-ed25519 for keygen + cert signing and with
 * a host cert vault for authoritative lookups.
 *
 * @param opts.enforceCapabilityBinding — default true. When on, also blocks
 *   tool calls where the tool is not listed in the verified cert's
 *   capabilities. Set to false for identity-only enforcement.
 */
export function requireSignedIdentity(
  opts: { enforceCapabilityBinding?: boolean; reason?: string } = {},
): PolicyRule {
  const enforceCapabilityBinding = opts.enforceCapabilityBinding !== false;
  return {
    id: "require-signed-identity",
    name: enforceCapabilityBinding
      ? "Require signed identity + capability binding"
      : "Require signed identity",
    condition: {
      type: "require_signed_identity",
      params: { enforceCapabilityBinding },
    },
    outcome: "block",
    reason:
      opts.reason ??
      "Agent did not present a valid signed identity for this action",
    // Priority 950 — just below kill_switch (999) so identity is verified
    // before almost everything else. Unsigned calls fail fast, before
    // wasting cycles on injection detection or resource checks.
    priority: 950,
    enabled: true,
    stage: "process",
  };
}

/**
 * Require a tool to be preceded by other tools in the session.
 * Example: requireSequence("delete_record", ["backup_record"])
 */
export function requireSequence(
  tool: string,
  requiredPrior: string[],
  reason?: string,
): PolicyRule {
  return {
    id: `sequence-${tool}-requires-${requiredPrior.join("-")}`,
    name: `${tool} requires: ${requiredPrior.join(", ")}`,
    condition: { type: "tool_sequence", params: { tool, requiredPrior } },
    outcome: "block",
    reason: reason ?? `${tool} requires prior call to: ${requiredPrior.join(", ")}`,
    priority: 85,
    enabled: true,
    stage: "process",
  };
}

/** Restrict actions to specific hours (24h format, local time) */
export function timeWindow(
  startHour: number,
  endHour: number,
  reason?: string,
): PolicyRule {
  return {
    id: `time-window-${startHour}-${endHour}`,
    name: `Allow ${startHour}:00-${endHour}:00 only`,
    condition: { type: "time_window", params: { allowedHours: { start: startHour, end: endHour } } },
    outcome: "block",
    reason: reason ?? `Action blocked outside allowed hours (${startHour}:00-${endHour}:00)`,
    priority: 50,
    enabled: true,
    stage: "process",
  };
}

/**
 * Block when a caller-supplied ML injection score exceeds the threshold.
 *
 * The policy engine is synchronous by design (zero-dep, no hidden I/O), so
 * async ML classifiers cannot run inside `enforce()` directly. Pattern:
 *
 *   1. Your host wrapper runs an ML classifier (e.g. `hybridDetect()` from
 *      `governance-sdk/injection-classifier`, or a Groq/Prompt-Guard-2 call).
 *   2. Host sets `ctx.mlInjectionScore` and optionally `ctx.mlInjectionCategories`.
 *   3. Host calls `gov.enforce(ctx)` — this preset reads the score and
 *      blocks when it meets or exceeds `threshold`.
 *
 * Pair with `createInjectionGuard()` (the built-in regex detector) for
 * defence in depth. Regex catches known syntactic attacks with low FPR;
 * ML catches the rest.
 */
export function mlInjectionGuard(opts: {
  threshold?: number;
  requireCategory?: string;
  reason?: string;
  id?: string;
} = {}): PolicyRule {
  const threshold = opts.threshold ?? 0.5;
  return {
    id: opts.id ?? "ml-injection-guard",
    name: `ML injection guard (threshold ${threshold})`,
    condition: {
      type: "ml_injection_guard",
      params: {
        threshold,
        ...(opts.requireCategory !== undefined ? { requireCategory: opts.requireCategory } : {}),
      },
    },
    outcome: "block",
    reason:
      opts.reason ??
      "ML classifier flagged input as injection (host-supplied ctx.mlInjectionScore)",
    priority: 130, // between tool allowlist (90) and requireSignedIdentity (950)
    enabled: true,
    stage: "preprocess",
  };
}
