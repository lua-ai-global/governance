/**
 * Policy Engine — before-action enforcement for AI agents.
 *
 * Evaluates rules in priority order against enforcement contexts.
 * Preset builders are in policy-presets.ts.
 */

import { getBuiltinConditions } from "./conditions/builtins.js";
import { getDefaultStage } from "./policy-stage-defaults.js";
import { maskSensitiveData, maskPattern, maskBlocklistTerms } from "./mask.js";
import { conditionSupportsModalities, type Modality } from "./scan/multi-modal.js";

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

export type PolicyOutcome = "allow" | "block" | "warn" | "require_approval" | "mask";

/**
 * Pipeline stages, in execution order:
 *
 *   preprocess  — user input before LLM (injection scanning, blocklists, length)
 *   process     — tool calls after LLM, before tool execution (block-tools, approval, budgets)
 *   tool_result — tool returns AFTER execution, before LLM ingests on next turn
 *                 (injection scanning of tool returns, scope re-checks, output redaction
 *                 of external content)
 *   postprocess — agent's final output before user (PII redaction, output filtering)
 *
 * `tool_result` exists separately from `postprocess` because the threat model
 * is different: tool_result protects the LLM context from external-content
 * injection; postprocess protects the user from agent leaks. Different default
 * conditions, different audit semantics.
 */
export type PolicyStage = "preprocess" | "process" | "tool_result" | "postprocess";

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
  /**
   * Which content modalities this rule scans. Only meaningful for
   * content-scanning conditions (`injection_guard`, `sensitive_data_filter`,
   * `blocklist`, `input_pattern`, `output_pattern`, `ml_injection_guard`).
   * Ignored for everything else. Use `conditionSupportsModalities()` from
   * `governance-sdk/scan/multi-modal` to validate before persisting.
   *
   * The host pre-extracts text per modality into `ctx.textByModality`
   * (typically by calling `scanMultiModal()` once for the union of
   * modalities across active rules). When `scanModalities` is unset or
   * empty, the evaluator falls back to its existing input-walk behaviour
   * — strict-improvement-only, no break risk for legacy rules.
   */
  scanModalities?: Modality[];
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
  /**
   * Whether the host successfully verified the caller's Ed25519 identity
   * against the authoritative cert vault.
   *
   * This field is populated by the HOST (API layer) before the policy engine
   * runs — the SDK is zero-dep and synchronous, so it cannot do the vault
   * lookup or crypto verify itself. The host resolves the agent's active cert,
   * checks signature + expiry, then sets this flag accordingly. The
   * `require_signed_identity` condition reads it.
   *
   * `true`  — valid signature, non-expired cert, cert exists in this org's vault
   * `false` — verification explicitly failed (see identityFailureReason)
   * `undefined` — host did not perform identity verification on this request
   */
  identityVerified?: boolean;
  /**
   * Whether `ctx.tool` is listed in the verified certificate's capability set.
   * Computed by the host at the same time as `identityVerified` so the policy
   * engine can do the capability-narrowing check with a single boolean read.
   *
   * `true`  — tool is in the cert's capabilities (or no tool on the request)
   * `false` — tool is NOT in the cert's capabilities (capability escalation)
   * `undefined` — host did not evaluate capability binding
   */
  identityCapabilityMatch?: boolean;
  /**
   * Human-readable reason when identityVerified === false.
   * One of: "no_cert" | "expired_cert" | "missing_signature" | "invalid_signature"
   * | "capability_not_in_cert" (or any string the host provides).
   */
  identityFailureReason?: string;
  /**
   * Score (0-1) from an ML injection classifier that the host ran BEFORE
   * calling `enforce()`. The policy engine is synchronous and cannot invoke
   * an async classifier itself — so the host runs the classifier (via
   * `hybridDetect()` or its own integration), populates this field, and the
   * `ml_injection_guard` condition reads it. `undefined` means the host
   * did not run an ML classifier on this request.
   */
  mlInjectionScore?: number;
  /**
   * Categories tagged by the ML classifier alongside `mlInjectionScore`.
   * Optional — enables the `ml_injection_guard` to narrow on category too.
   */
  mlInjectionCategories?: string[];
  /**
   * Pre-extracted text per modality, populated by the host before calling
   * `enforce()`. Typically the host calls `scanMultiModal()` once per
   * request for the union of modalities across active rules and stuffs
   * the result here. Content-scanning condition evaluators consult this
   * via `getScanText(ctx, rule)` when the rule has `scanModalities` set.
   *
   * `textByModality.text` is the user's prompt; `textByModality.image` is
   * the OCR'd / vision-LLM extraction of image blocks; etc. Empty or
   * undefined entries are equivalent to "no contribution from that
   * modality." The SDK never populates this itself — host responsibility.
   */
  textByModality?: Partial<Record<Modality, string>>;
}

export interface EnforcementDecision {
  blocked: boolean;
  reason: string;
  ruleId: string | null;
  outcome: PolicyOutcome;
  evaluatedAt: string;
  rulesEvaluated: number;
  /** Redacted text when outcome is "mask" — the transformed version with sensitive data replaced */
  maskedText?: string;
  /** Approval request ID when outcome is "require_approval" */
  approvalId?: string;
  /** Approval details with polling endpoint for async approval flows */
  approval?: {
    id: string;
    status: string;
    pollUrl: string;
    message: string;
  };
}

// ─── Condition Registry ─────────────────────────────────────────

/**
 * Evaluator function for a registered condition type.
 *
 * The optional `rule` argument is the parent PolicyRule that the engine is
 * currently evaluating. Most evaluators ignore it; content-scanning
 * evaluators (`injection_guard`, `sensitive_data_filter`, `blocklist`,
 * `input_pattern`, `output_pattern`, `ml_injection_guard`) read
 * `rule.scanModalities` via `getScanText()` to know which slices of
 * `ctx.textByModality` to scan.
 *
 * Adding `rule?` is structurally backward compatible — existing
 * `(ctx, params) => boolean` implementations satisfy the wider signature
 * unchanged.
 */
export type ConditionEvaluator = (
  ctx: EnforcementContext,
  params: Record<string, unknown>,
  rule?: PolicyRule,
) => boolean;

/**
 * Pull scannable text from `ctx.textByModality` for a content-scanning rule.
 *
 * Returns an array of strings (typically the per-modality texts plus a
 * joined-all version, mirroring `extractStrings`'s shape) when:
 *   - a rule was passed,
 *   - the rule's condition type supports modalities, and
 *   - the rule has `scanModalities` set.
 *
 * Returns `null` to signal "use the existing extractStrings(ctx.input)
 * fallback" — for legacy rules that don't opt in. This is the
 * backward-compat seam: rules without `scanModalities` see exactly the
 * same content they did before this feature shipped.
 */
export function getScanText(
  ctx: EnforcementContext,
  rule?: PolicyRule,
): string[] | null {
  if (!rule) return null;
  if (!conditionSupportsModalities(rule.condition.type)) return null;
  const modalities = rule.scanModalities;
  if (!modalities || modalities.length === 0) return null;

  const out: string[] = [];
  for (const m of modalities) {
    const t = ctx.textByModality?.[m];
    if (typeof t === "string" && t.length > 0) out.push(t);
  }
  if (out.length > 1) out.push(out.join(" "));
  return out;
}

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

  function evaluateCondition(
    condition: PolicyCondition,
    ctx: EnforcementContext,
    rule?: PolicyRule,
  ): boolean {
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
    return entry.evaluator(ctx, condition.params, rule);
  }

  // Register built-in conditions
  for (const def of getBuiltinConditions(evaluateCondition)) {
    registry.set(def.name, def);
  }

  // Register any custom conditions from config
  for (const entry of config.conditions ?? []) {
    registry.set(entry.name, entry);
  }

  // Same clamp as addRule() — priorities >= 999 are reserved for system
  // rules (kill switch). User rules passed at init are capped at 998.
  const rules: PolicyRule[] = (config.rules ?? []).map((r) =>
    r.id.startsWith("__") || r.priority < 999 ? r : { ...r, priority: 998 },
  );
  const defaultOutcome = config.defaultOutcome ?? "allow";

  /** Compute masked text when outcome is "mask" based on the condition type and context. */
  function computeMaskedText(rule: PolicyRule, ctx: EnforcementContext): string | undefined {
    const { type, params } = rule.condition;
    const text = ctx.outputText ?? (ctx.input?.prompt as string | undefined) ?? "";
    if (!text) return undefined;

    if (type === "sensitive_data_filter") {
      return maskSensitiveData(text, params.patterns as string[] | undefined);
    }
    if (type === "output_pattern" || type === "input_pattern") {
      return maskPattern(text, params.pattern as string, params.flags as string | undefined);
    }
    if (type === "blocklist") {
      return maskBlocklistTerms(text, params.terms as string[]);
    }
    // Fallback: return text unchanged (condition detected something but we don't know how to mask)
    return text;
  }

  function buildDecision(rule: PolicyRule, ctx: EnforcementContext, rulesEvaluated: number): EnforcementDecision {
    return {
      blocked: rule.outcome === "block" || rule.outcome === "require_approval",
      reason: rule.reason,
      ruleId: rule.id,
      outcome: rule.outcome,
      evaluatedAt: new Date().toISOString(),
      rulesEvaluated,
      ...(rule.outcome === "mask" ? { maskedText: computeMaskedText(rule, ctx) } : {}),
    };
  }

  function evaluate(ctx: EnforcementContext): EnforcementDecision {
    const active = rules.filter((r) => r.enabled).sort((a, b) => b.priority - a.priority);

    for (const rule of active) {
      if (evaluateCondition(rule.condition, ctx, rule)) {
        return buildDecision(rule, ctx, active.length);
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
    // Priorities >= 999 are reserved for internal system rules (kill switch
    // et al.). User rules are clamped at 998 so the kill switch remains
    // the unconditional top priority. Internal callers mark their rules
    // with a `__` id prefix to opt out of the clamp.
    const clamped =
      rule.id.startsWith("__") || rule.priority < 999
        ? rule
        : { ...rule, priority: 998 };
    const idx = rules.findIndex((r) => r.id === clamped.id);
    if (idx >= 0) rules[idx] = clamped;
    else rules.push(clamped);
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
      if (evaluateCondition(rule.condition, ctx, rule)) {
        return buildDecision(rule, ctx, active.length);
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
  requireSignedIdentity,
  requireSequence,
  timeWindow,
} from "./policy-presets.js";
