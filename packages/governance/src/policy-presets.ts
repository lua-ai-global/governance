/**
 * Policy Preset Builders
 *
 * Convenience functions that create common PolicyRule configurations.
 * Separated from the policy engine to keep files under 300 LOC.
 */

import type { PolicyRule, PolicyAction } from "./policy";

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
    condition: { type: "tool_blocked", tools },
    outcome: "block",
    reason: reason ?? `Tool is on the blocked list: ${tools.join(", ")}`,
    priority: 100,
    enabled: true,
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
    condition: { type: "tool_allowed", tools },
    outcome: "block",
    reason: reason ?? `Tool is not on the approved list`,
    priority: 90,
    enabled: true,
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
    condition: { type: "action_type", actions },
    outcome: "require_approval",
    reason: reason ?? `Action requires human approval: ${actions.join(", ")}`,
    priority: 80,
    enabled: true,
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
    condition: { type: "token_limit", maxTokens },
    outcome: "block",
    reason: `Session token budget exceeded (${maxTokens.toLocaleString()} max)`,
    priority: 70,
    enabled: true,
  };
}

/**
 * Rate-limit agent actions within a time window.
 *
 * @param maxActions - Maximum actions allowed in the window
 * @param windowMs - Window duration in milliseconds
 * @returns A PolicyRule with priority 60 that blocks when rate exceeded
 */
export function rateLimit(maxActions: number, windowMs: number): PolicyRule {
  return {
    id: `rate-limit-${maxActions}-${windowMs}`,
    name: `Rate limit: ${maxActions} per ${windowMs}ms`,
    condition: { type: "rate_limit", maxActions, windowMs },
    outcome: "block",
    reason: `Rate limit exceeded (${maxActions} actions per ${windowMs / 1000}s window)`,
    priority: 60,
    enabled: true,
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
    condition: { type: "agent_level", minLevel },
    outcome: "block",
    reason: `Agent governance level below required minimum (L${minLevel})`,
    priority: 95,
    enabled: true,
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
    condition: { type: "tool_sequence", tool, requiredPrior },
    outcome: "block",
    reason: reason ?? `${tool} requires prior call to: ${requiredPrior.join(", ")}`,
    priority: 85,
    enabled: true,
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
    condition: { type: "time_window", allowedHours: { start: startHour, end: endHour } },
    outcome: "block",
    reason: reason ?? `Action blocked outside allowed hours (${startHour}:00-${endHour}:00)`,
    priority: 50,
    enabled: true,
  };
}
