/**
 * Policy Engine — before-action enforcement for AI agents.
 *
 * Evaluates rules in priority order against enforcement contexts.
 * Preset builders are in policy-presets.ts.
 */

import { detectInjection } from "./injection-detect.js";
import type { InjectionCategory } from "./injection-detect.js";

// ─── Types ──────────────────────────────────────────────────────

export type PolicyAction =
  | "tool_call"
  | "message_send"
  | "data_access"
  | "external_request"
  | "file_write"
  | "database_mutation"
  | "payment"
  | "custom";

export type PolicyOutcome = "allow" | "block" | "warn" | "require_approval";

export interface PolicyRule {
  id: string;
  name: string;
  condition: PolicyCondition;
  outcome: PolicyOutcome;
  reason: string;
  priority: number;
  enabled: boolean;
}

export type PolicyCondition =
  | { type: "tool_blocked"; tools: string[] }
  | { type: "tool_allowed"; tools: string[] }
  | { type: "action_type"; actions: PolicyAction[] }
  | { type: "token_limit"; maxTokens: number }
  | { type: "rate_limit"; maxActions: number; windowMs: number }
  | { type: "data_classification"; blocked: string[] }
  | { type: "agent_level"; minLevel: number }
  | { type: "tool_sequence"; tool: string; requiredPrior: string[] }
  | { type: "time_window"; allowedHours: { start: number; end: number } }
  | { type: "any_of"; conditions: PolicyCondition[] }
  | { type: "all_of"; conditions: PolicyCondition[] }
  | { type: "not"; condition: PolicyCondition }
  | { type: "injection_guard"; threshold: number; skipCategories: string[] }
  | { type: "custom"; evaluate: (ctx: EnforcementContext) => boolean };

export interface EnforcementContext {
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  action: PolicyAction;
  tool?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  sessionTokensUsed?: number;
  recentActionCount?: number;
  toolHistory?: string[];
}

export interface EnforcementDecision {
  blocked: boolean;
  reason: string;
  ruleId: string | null;
  outcome: PolicyOutcome;
  evaluatedAt: string;
  rulesEvaluated: number;
}

// ─── Policy Engine ──────────────────────────────────────────────

export interface PolicyEngine {
  evaluate: (ctx: EnforcementContext) => EnforcementDecision;
  addRule: (rule: PolicyRule) => void;
  removeRule: (ruleId: string) => void;
  getRules: () => PolicyRule[];
  ruleCount: number;
}

export interface PolicyEngineConfig {
  rules?: PolicyRule[];
  defaultOutcome?: PolicyOutcome;
}

/**
 * Create a standalone policy engine for before-action enforcement.
 *
 * @param config - Rules and default outcome options
 * @returns A PolicyEngine with evaluate, addRule, removeRule, and getRules
 *
 * @example
 * ```ts
 * const engine = createPolicyEngine({ rules: [blockTools(['shell_exec'])] });
 * const decision = engine.evaluate({ agentId: 'a1', action: 'tool_call', tool: 'shell_exec' });
 * ```
 */
export function createPolicyEngine(config: PolicyEngineConfig = {}): PolicyEngine {
  const rules: PolicyRule[] = [...(config.rules ?? [])];
  const defaultOutcome = config.defaultOutcome ?? "allow";

  function evaluate(ctx: EnforcementContext): EnforcementDecision {
    const active = rules.filter((r) => r.enabled).sort((a, b) => b.priority - a.priority);

    for (const rule of active) {
      if (evaluateCondition(rule.condition, ctx)) {
        return {
          blocked: rule.outcome === "block" || rule.outcome === "require_approval",
          reason: rule.reason,
          ruleId: rule.id,
          outcome: rule.outcome,
          evaluatedAt: new Date().toISOString(),
          rulesEvaluated: active.length,
        };
      }
    }

    return {
      blocked: defaultOutcome === "block",
      reason: "No policy rules matched",
      ruleId: null,
      outcome: defaultOutcome,
      evaluatedAt: new Date().toISOString(),
      rulesEvaluated: active.length,
    };
  }

  function addRule(rule: PolicyRule): void {
    const idx = rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) rules[idx] = rule;
    else rules.push(rule);
  }

  function removeRule(ruleId: string): void {
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx >= 0) rules.splice(idx, 1);
  }

  function getRules(): PolicyRule[] {
    return [...rules];
  }

  return {
    evaluate,
    addRule,
    removeRule,
    getRules,
    get ruleCount() { return rules.filter((r) => r.enabled).length; },
  };
}

// ─── Condition Evaluators ───────────────────────────────────────

function evaluateCondition(condition: PolicyCondition, ctx: EnforcementContext): boolean {
  switch (condition.type) {
    case "tool_blocked":
      return !!ctx.tool && condition.tools.includes(ctx.tool);
    case "tool_allowed":
      return !!ctx.tool && !condition.tools.includes(ctx.tool);
    case "action_type":
      return condition.actions.includes(ctx.action);
    case "token_limit":
      return (ctx.sessionTokensUsed ?? 0) > condition.maxTokens;
    case "rate_limit":
      // Note: This is a declarative threshold check on caller-supplied recentActionCount.
      // The SDK does NOT track action counts — the caller must provide accurate counts.
      // For server-side rate limiting, use Upstash/Redis in the API layer.
      return (ctx.recentActionCount ?? 0) > condition.maxActions;
    case "data_classification": {
      if (!ctx.input) return false;
      const inputStr = JSON.stringify(ctx.input).toLowerCase();
      return condition.blocked.some((b) => inputStr.includes(b.toLowerCase()));
    }
    case "agent_level":
      return (ctx.agentLevel ?? 0) < condition.minLevel;
    case "tool_sequence":
      if (ctx.tool !== condition.tool) return false;
      if (!ctx.toolHistory || ctx.toolHistory.length === 0) return true;
      return !condition.requiredPrior.every((t) => ctx.toolHistory!.includes(t));
    case "time_window": {
      const hour = new Date().getHours();
      const { start, end } = condition.allowedHours;
      if (start <= end) return hour < start || hour >= end;
      return hour < start && hour >= end;
    }
    case "any_of":
      return condition.conditions.some((c) => evaluateCondition(c, ctx));
    case "all_of":
      return condition.conditions.every((c) => evaluateCondition(c, ctx));
    case "not":
      return !evaluateCondition(condition.condition, ctx);
    case "injection_guard": {
      if (!ctx.input) return false;
      const strings = extractStringsForInjection(ctx.input);
      const skip = condition.skipCategories as InjectionCategory[];
      for (const str of strings) {
        const result = detectInjection(str, {
          threshold: condition.threshold,
          skipCategories: skip.length > 0 ? skip : undefined,
        });
        if (result.detected) return true;
      }
      return false;
    }
    case "custom": {
      const result = condition.evaluate(ctx);
      // Guard against async evaluators — they'd be truthy and silently always match
      if (result !== null && typeof result === "object" && typeof (result as Promise<boolean>).then === "function") {
        throw new Error(
          "Custom policy evaluator returned a Promise — evaluators must be synchronous. " +
          "Move async logic outside the policy engine or pre-compute the result.",
        );
      }
      return result;
    }
  }
}

/** Extract all string values from a nested object for injection scanning */
function extractStringsForInjection(obj: Record<string, unknown>): string[] {
  const strings: string[] = [];
  function walk(value: unknown): void {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  }
  walk(obj);
  if (strings.length > 1) strings.push(strings.join(" "));
  return strings;
}

// ─── Re-export presets ──────────────────────────────────────────

export {
  blockTools,
  allowOnlyTools,
  requireApproval,
  tokenBudget,
  rateLimit,
  requireLevel,
  requireSequence,
  timeWindow,
} from "./policy-presets.js";
