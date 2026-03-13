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

const conditionRegistry = new Map<string, RegisteredConditionType>();

/**
 * Register a condition type. The evaluator lives in the registry while
 * the rule itself (`{ type, params }`) is pure data — serializable, storable, transportable.
 *
 * @param entry - Name, description, evaluator function, and optional param schema
 * @param opts - Set `override: true` to replace an existing condition (e.g., override a built-in)
 *
 * @example
 * ```ts
 * registerCondition({
 *   name: 'geo_fence',
 *   description: 'Block actions outside allowed regions',
 *   evaluator: (ctx, params) => {
 *     const region = ctx.metadata?.region as string;
 *     const allowed = params.allowedRegions as string[];
 *     return !region || !allowed.includes(region);
 *   },
 *   paramSchema: { type: 'object', properties: { allowedRegions: { type: 'array', items: { type: 'string' } } } },
 * });
 * ```
 */
export function registerCondition(entry: RegisteredConditionType, opts?: { override?: boolean }): void {
  if (conditionRegistry.has(entry.name) && !opts?.override) {
    throw new Error(`Condition type "${entry.name}" is already registered. Use { override: true } to replace.`);
  }
  conditionRegistry.set(entry.name, entry);
}

/** Unregister a previously registered condition type */
export function unregisterCondition(name: string): boolean {
  return conditionRegistry.delete(name);
}

/** Get a registered condition type by name */
export function getRegisteredCondition(name: string): RegisteredConditionType | undefined {
  return conditionRegistry.get(name);
}

/** List all registered condition types */
export function getRegisteredConditions(): RegisteredConditionType[] {
  return [...conditionRegistry.values()];
}

/** Clear all registered conditions (primarily for testing). Set `keepBuiltins: true` to re-register built-ins after clearing. */
export function clearConditionRegistry(opts?: { keepBuiltins?: boolean }): void {
  conditionRegistry.clear();
  builtinsRegistered = false;
  if (opts?.keepBuiltins) registerBuiltinConditions();
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
  registerBuiltinConditions();
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

  return {
    evaluate,
    evaluateStage,
    addRule,
    removeRule,
    getRules,
    get ruleCount() { return rules.filter((r) => r.enabled).length; },
  };
}

// ─── Built-in Registration ──────────────────────────────────────

let builtinsRegistered = false;

/** Register all 25 built-in condition evaluators. Idempotent. */
export function registerBuiltinConditions(): void {
  if (builtinsRegistered) return;
  for (const def of getBuiltinConditions(evaluateCondition)) {
    if (!conditionRegistry.has(def.name)) {
      conditionRegistry.set(def.name, def);
    }
  }
  builtinsRegistered = true;
}

// ─── Condition Evaluator ────────────────────────────────────────

function evaluateCondition(condition: PolicyCondition, ctx: EnforcementContext): boolean {
  // Backwards compat: inline custom evaluators (params.evaluate is a function)
  const evalFn = condition.params?.evaluate;
  if (typeof evalFn === "function") {
    const r = (evalFn as (ctx: EnforcementContext) => boolean)(ctx);
    if (r && typeof r === "object" && typeof (r as Promise<boolean>).then === "function") {
      throw new Error("Custom policy evaluator returned a Promise — evaluators must be synchronous.");
    }
    return r;
  }

  const entry = conditionRegistry.get(condition.type);
  if (!entry) {
    throw new Error(`Unknown condition type "${condition.type}" — register it via registerCondition()`);
  }
  return entry.evaluator(ctx, condition.params);
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
