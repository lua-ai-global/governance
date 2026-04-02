/**
 * Built-in condition evaluators — registered at engine initialization.
 * All 25 condition types from the original switch statement, now pluggable.
 */

import type { ConditionEvaluator, EnforcementContext, PolicyCondition } from "../policy.js";
import { detectInjection } from "../injection-detect.js";
import type { InjectionCategory } from "../injection-detect.js";
import { evaluateBlocklist, evaluateInputLength, evaluateInputPattern } from "./preprocess.js";
import { evaluateNetworkAllowlist, evaluateScopeBoundary, evaluateCostBudget, evaluateConcurrentLimit } from "./process.js";
import { evaluateOutputLength, evaluateOutputPattern, evaluateSensitiveDataFilter } from "./postprocess.js";

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

type BuiltinDef = { name: string; description: string; evaluator: ConditionEvaluator };

/**
 * Create the full list of built-in condition definitions.
 * Accepts `evalCondition` so combinators (any_of, all_of, not) can recurse.
 */
export function getBuiltinConditions(
  evalCondition: (condition: PolicyCondition, ctx: EnforcementContext) => boolean,
): BuiltinDef[] {
  return [
    // ─── Access control ────────────────────────────────────────
    {
      name: "tool_blocked",
      description: "Block specific tools",
      evaluator: (ctx, p) => {
        const tools = p.tools as string[];
        return !!ctx.tool && tools.includes(ctx.tool);
      },
    },
    {
      name: "tool_allowed",
      description: "Only allow listed tools",
      evaluator: (ctx, p) => {
        const tools = p.tools as string[];
        return !!ctx.tool && !tools.includes(ctx.tool);
      },
    },
    {
      name: "action_type",
      description: "Gate specific action types",
      evaluator: (ctx, p) => {
        const actions = p.actions as string[];
        return actions.includes(ctx.action);
      },
    },
    {
      name: "agent_level",
      description: "Require minimum governance level",
      evaluator: (ctx, p) => {
        const minLevel = p.minLevel as number;
        return (ctx.agentLevel ?? 0) < minLevel;
      },
    },
    {
      name: "tool_sequence",
      description: "Require tools to run in order",
      evaluator: (ctx, p) => {
        const tool = p.tool as string;
        const requiredPrior = p.requiredPrior as string[];
        if (ctx.tool !== tool) return false;
        if (!ctx.toolHistory || ctx.toolHistory.length === 0) return true;
        return !requiredPrior.every((t) => ctx.toolHistory!.includes(t));
      },
    },
    // ─── Resource limits ───────────────────────────────────────
    {
      name: "token_limit",
      description: "Cap per-session token usage",
      evaluator: (ctx, p) => (ctx.sessionTokensUsed ?? 0) > (p.maxTokens as number),
    },
    {
      name: "rate_limit",
      description: "Limit actions per time window",
      evaluator: (ctx, p) => (ctx.recentActionCount ?? 0) > (p.maxActions as number),
    },
    {
      name: "data_classification",
      description: "Block classified data access",
      evaluator: (ctx, p) => {
        if (!ctx.input) return false;
        const blocked = p.blocked as string[];
        const inputStr = JSON.stringify(ctx.input).toLowerCase();
        return blocked.some((b) => inputStr.includes(b.toLowerCase()));
      },
    },
    {
      name: "time_window",
      description: "Restrict to specific hours",
      evaluator: (_ctx, p) => {
        const hour = new Date().getHours();
        const hours = p.allowedHours as { start: number; end: number };
        if (hours.start <= hours.end) return hour < hours.start || hour >= hours.end;
        return hour < hours.start && hour >= hours.end;
      },
    },
    {
      name: "cost_budget",
      description: "Cap monetary cost per session",
      evaluator: (ctx, p) => evaluateCostBudget(ctx, p.maxCost as number),
    },
    {
      name: "concurrent_limit",
      description: "Cap parallel tool executions",
      evaluator: (ctx, p) => evaluateConcurrentLimit(ctx, p.maxConcurrent as number),
    },
    {
      name: "network_allowlist",
      description: "Only allow listed domains",
      evaluator: (ctx, p) => evaluateNetworkAllowlist(ctx, p.allowedDomains as string[]),
    },
    {
      name: "scope_boundary",
      description: "Restrict file/resource access paths",
      evaluator: (ctx, p) => evaluateScopeBoundary(ctx, p.allowedPaths as string[] | undefined, p.blockedPaths as string[] | undefined),
    },
    // ─── Input safety (preprocess) ─────────────────────────────
    {
      name: "injection_guard",
      description: "Detect prompt injection attacks",
      evaluator: (ctx, p) => {
        if (!ctx.input) return false;
        const skip = (p.skipCategories ?? []) as InjectionCategory[];
        const opts = { threshold: p.threshold as number, skipCategories: skip.length > 0 ? skip : undefined };
        for (const str of extractStrings(ctx.input)) {
          if (detectInjection(str, opts).detected) return true;
        }
        return false;
      },
    },
    {
      name: "blocklist",
      description: "Block input containing specific terms",
      evaluator: (ctx, p) => evaluateBlocklist(ctx, p.terms as string[], p.caseSensitive as boolean | undefined),
    },
    {
      name: "input_length",
      description: "Reject oversized inputs",
      evaluator: (ctx, p) => evaluateInputLength(ctx, p.maxChars as number | undefined, p.maxTokens as number | undefined),
    },
    {
      name: "input_pattern",
      description: "Block input matching a regex",
      evaluator: (ctx, p) => evaluateInputPattern(ctx, p.pattern as string, p.flags as string | undefined),
    },
    // ─── Output safety (postprocess) ───────────────────────────
    {
      name: "output_length",
      description: "Reject oversized outputs",
      evaluator: (ctx, p) => evaluateOutputLength(ctx, p.maxChars as number | undefined, p.maxTokens as number | undefined),
    },
    {
      name: "output_pattern",
      description: "Detect patterns in output",
      evaluator: (ctx, p) => evaluateOutputPattern(ctx, p.pattern as string, p.flags as string | undefined),
    },
    {
      name: "sensitive_data_filter",
      description: "Detect leaked credentials and secrets",
      evaluator: (ctx, p) => evaluateSensitiveDataFilter(ctx, p.patterns as string[] | undefined),
    },
    // ─── Identity ─────────────────────────────────────────────
    {
      name: "require_signed_action",
      description: "Require a cryptographic signature in action metadata",
      evaluator: (ctx) => {
        // Block if no signature present in metadata
        const meta = ctx.metadata as Record<string, unknown> | undefined;
        return !meta || !meta.signature || typeof meta.signature !== "string";
      },
    },
    // ─── Combinators ───────────────────────────────────────────
    {
      name: "any_of",
      description: "Match if any sub-condition matches",
      evaluator: (ctx, p) => {
        const conditions = p.conditions as PolicyCondition[];
        return conditions.some((c) => evalCondition(c, ctx));
      },
    },
    {
      name: "all_of",
      description: "Match if all sub-conditions match",
      evaluator: (ctx, p) => {
        const conditions = p.conditions as PolicyCondition[];
        return conditions.every((c) => evalCondition(c, ctx));
      },
    },
    {
      name: "not",
      description: "Invert a condition",
      evaluator: (ctx, p) => {
        const condition = p.condition as PolicyCondition;
        return !evalCondition(condition, ctx);
      },
    },
  ];
}
