/**
 * Policy Engine — before-action enforcement for AI agents.
 *
 * Evaluates rules in priority order against enforcement contexts.
 * Preset builders are in policy-presets.ts.
 */

import { detectInjection } from "./injection-detect.js";
import type { InjectionCategory } from "./injection-detect.js";
import { evaluateBlocklist, evaluateInputLength, evaluateInputPattern } from "./conditions/preprocess.js";
import { evaluateNetworkAllowlist, evaluateScopeBoundary, evaluateCostBudget, evaluateConcurrentLimit } from "./conditions/process.js";
import { evaluateOutputLength, evaluateOutputPattern, evaluateSensitiveDataFilter } from "./conditions/postprocess.js";

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

export type PolicyStage = "preprocess" | "process" | "postprocess";

export interface PolicyRule {
  id: string;
  name: string;
  condition: PolicyCondition;
  outcome: PolicyOutcome;
  reason: string;
  priority: number;
  enabled: boolean;
  /** Pipeline stage — defaults to "process" when omitted */
  stage?: PolicyStage;
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
  | { type: "blocklist"; terms: string[]; caseSensitive?: boolean }
  | { type: "input_length"; maxChars?: number; maxTokens?: number }
  | { type: "input_pattern"; pattern: string; flags?: string }
  | { type: "network_allowlist"; allowedDomains: string[] }
  | { type: "scope_boundary"; allowedPaths?: string[]; blockedPaths?: string[] }
  | { type: "cost_budget"; maxCost: number; currency?: string }
  | { type: "concurrent_limit"; maxConcurrent: number }
  | { type: "output_length"; maxChars?: number; maxTokens?: number }
  | { type: "output_pattern"; pattern: string; flags?: string }
  | { type: "sensitive_data_filter"; patterns?: string[] }
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
  /** Output text for postprocess evaluation */
  outputText?: string;
  /** Output token count for postprocess evaluation */
  outputTokenCount?: number;
  /** Execution duration in ms for postprocess evaluation */
  executionDurationMs?: number;
  /** Target URL/domain for network_allowlist evaluation */
  targetUrl?: string;
  /** Target file/resource path for scope_boundary evaluation */
  targetPath?: string;
  /** Session cost so far for cost_budget evaluation */
  sessionCost?: number;
  /** Current concurrent tool count for concurrent_limit evaluation */
  concurrentCount?: number;
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
  /** Evaluate only rules matching the given stage */
  evaluateStage: (ctx: EnforcementContext, stage: PolicyStage) => EnforcementDecision;
  addRule: (rule: PolicyRule) => void;
  removeRule: (ruleId: string) => void;
  getRules: (stage?: PolicyStage) => PolicyRule[];
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

  function evaluateStage(ctx: EnforcementContext, stage: PolicyStage): EnforcementDecision {
    const active = rules
      .filter((r) => r.enabled && (r.stage ?? "process") === stage)
      .sort((a, b) => b.priority - a.priority);

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

  function getRules(stage?: PolicyStage): PolicyRule[] {
    if (stage) return rules.filter((r) => (r.stage ?? "process") === stage);
    return [...rules];
  }

  return {
    evaluate,
    evaluateStage,
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
      const skip = condition.skipCategories as InjectionCategory[];
      const opts = { threshold: condition.threshold, skipCategories: skip.length > 0 ? skip : undefined };
      for (const str of extractStrings(ctx.input)) {
        if (detectInjection(str, opts).detected) return true;
      }
      return false;
    }
    case "blocklist":
      return evaluateBlocklist(ctx, condition.terms, condition.caseSensitive);
    case "input_length":
      return evaluateInputLength(ctx, condition.maxChars, condition.maxTokens);
    case "input_pattern":
      return evaluateInputPattern(ctx, condition.pattern, condition.flags);
    case "network_allowlist":
      return evaluateNetworkAllowlist(ctx, condition.allowedDomains);
    case "scope_boundary":
      return evaluateScopeBoundary(ctx, condition.allowedPaths, condition.blockedPaths);
    case "cost_budget":
      return evaluateCostBudget(ctx, condition.maxCost);
    case "concurrent_limit":
      return evaluateConcurrentLimit(ctx, condition.maxConcurrent);
    case "output_length":
      return evaluateOutputLength(ctx, condition.maxChars, condition.maxTokens);
    case "output_pattern":
      return evaluateOutputPattern(ctx, condition.pattern, condition.flags);
    case "sensitive_data_filter":
      return evaluateSensitiveDataFilter(ctx, condition.patterns);
    case "custom": {
      const r = condition.evaluate(ctx);
      if (r && typeof r === "object" && typeof (r as Promise<boolean>).then === "function") {
        throw new Error("Custom policy evaluator returned a Promise — evaluators must be synchronous.");
      }
      return r;
    }
  }
}

/** Extract all string values from a nested object for scanning */
function extractStrings(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  (function walk(v: unknown) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  })(obj);
  if (out.length > 1) out.push(out.join(" "));
  return out;
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
