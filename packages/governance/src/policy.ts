/**
 * Policy Engine — before-action enforcement for AI agents.
 *
 * Evaluates rules in priority order against enforcement contexts.
 * Preset builders are in policy-presets.ts.
 */

import { getBuiltinConditions } from "./conditions/builtins.js";
import { getDefaultStage } from "./policy-stage-defaults.js";

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

/**
 * A policy condition — built-in or plugin-provided.
 * `type` identifies the evaluator (looked up in the condition registry).
 * `params` holds the configuration for that evaluator.
 */
export interface PolicyCondition {
  type: string;
  params: Record<string, unknown>;
}

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

// ─── Condition Registry ─────────────────────────────────────────

/** Evaluator function for a registered condition type */
export type ConditionEvaluator = (ctx: EnforcementContext, params: Record<string, unknown>) => boolean;

/** Metadata for a registered condition type */
export interface RegisteredConditionType {
  name: string;
  description: string;
  evaluator: ConditionEvaluator;
  /** JSON Schema for params — enables visual builders to render config UIs */
  paramSchema?: Record<string, unknown>;
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
  /** Register a custom condition type on this engine instance */
  registerCondition: (entry: RegisteredConditionType, opts?: { override?: boolean }) => void;
  /** Unregister a condition type by name */
  unregisterCondition: (name: string) => boolean;
  /** Get a registered condition type by name */
  getRegisteredCondition: (name: string) => RegisteredConditionType | undefined;
  /** List all registered condition types */
  getRegisteredConditions: () => RegisteredConditionType[];
  /** Clear all registered conditions. Set `keepBuiltins: true` to re-register built-ins after clearing. */
  clearConditionRegistry: (opts?: { keepBuiltins?: boolean }) => void;
}

export interface PolicyEngineConfig {
  rules?: PolicyRule[];
  defaultOutcome?: PolicyOutcome;
  /** Custom condition types to register on this engine instance */
  conditions?: RegisteredConditionType[];
}

/**
 * Create a standalone policy engine for before-action enforcement.
 *
 * Each engine has its own isolated condition registry — built-in conditions
 * are registered automatically, and custom conditions can be added via
 * `config.conditions` or `engine.registerCondition()`.
 *
 * @param config - Rules, default outcome, and custom conditions
 * @returns A PolicyEngine with evaluate, addRule, removeRule, getRules, and condition management
 *
 * @example
 * ```ts
 * const engine = createPolicyEngine({
 *   rules: [blockTools(['shell_exec'])],
 *   conditions: [{ name: 'geo_fence', description: 'Block by region', evaluator: myEval }],
 * });
 * const decision = engine.evaluate({ agentId: 'a1', action: 'tool_call', tool: 'shell_exec' });
 * ```
 */
export function createPolicyEngine(config: PolicyEngineConfig = {}): PolicyEngine {
  // Instance-scoped condition registry — fully isolated per engine
  const registry = new Map<string, RegisteredConditionType>();

  function evaluateCondition(condition: PolicyCondition, ctx: EnforcementContext): boolean {
    // Inline custom evaluators (params.evaluate is a function)
    const evalFn = condition.params?.evaluate;
    if (typeof evalFn === "function") {
      const r = (evalFn as (ctx: EnforcementContext) => boolean)(ctx);
      if (r && typeof r === "object" && typeof (r as Promise<boolean>).then === "function") {
        throw new Error("Custom policy evaluator returned a Promise — evaluators must be synchronous.");
      }
      return r;
    }

    const entry = registry.get(condition.type);
    if (!entry) {
      throw new Error(`Unknown condition type "${condition.type}" — register it via engine.registerCondition()`);
    }
    return entry.evaluator(ctx, condition.params);
  }

  // Register built-in conditions
  for (const def of getBuiltinConditions(evaluateCondition)) {
    registry.set(def.name, def);
  }

  // Register any custom conditions from config
  for (const entry of config.conditions ?? []) {
    registry.set(entry.name, entry);
  }

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
      .filter((r) => r.enabled && (r.stage ?? getDefaultStage(r.condition.type)) === stage)
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
    if (stage) return rules.filter((r) => (r.stage ?? getDefaultStage(r.condition.type)) === stage);
    return [...rules];
  }

  function registerCondition(entry: RegisteredConditionType, opts?: { override?: boolean }): void {
    if (registry.has(entry.name) && !opts?.override) {
      throw new Error(`Condition type "${entry.name}" is already registered. Use { override: true } to replace.`);
    }
    registry.set(entry.name, entry);
  }

  function unregisterCondition(name: string): boolean {
    return registry.delete(name);
  }

  function getRegisteredCondition(name: string): RegisteredConditionType | undefined {
    return registry.get(name);
  }

  function getRegisteredConditions(): RegisteredConditionType[] {
    return [...registry.values()];
  }

  function clearConditionRegistry(opts?: { keepBuiltins?: boolean }): void {
    registry.clear();
    if (opts?.keepBuiltins) {
      for (const def of getBuiltinConditions(evaluateCondition)) {
        registry.set(def.name, def);
      }
    }
  }

  return {
    evaluate,
    evaluateStage,
    addRule,
    removeRule,
    getRules,
    get ruleCount() { return rules.filter((r) => r.enabled).length; },
    registerCondition,
    unregisterCondition,
    getRegisteredCondition,
    getRegisteredConditions,
    clearConditionRegistry,
  };
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
