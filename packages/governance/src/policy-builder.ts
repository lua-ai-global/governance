/**
 * @lua-ai-global/governance — Fluent Policy Builder DSL
 *
 * TypeScript-native fluent API for building policy rules.
 * Produces standard PolicyRule objects compatible with createGovernance().
 *
 * @example
 * ```ts
 * import { when } from '@lua-ai-global/governance/policy-builder';
 *
 * const rule = when().tool('shell_exec').then().block('Dangerous tool blocked');
 * const rule2 = when().action('payment').then().requireApproval('Payments need human review');
 * const rule3 = when().level().below(2).then().block('Insufficient governance level');
 * governance.addRule(rule);
 * ```
 */

import type { PolicyRule, PolicyAction, PolicyStage } from "./policy.js";

// ─── Types ───────────────────────────────────────────────────

interface ConditionBuilder {
  tool(name: string): OutcomeStage;
  tools(names: string[]): OutcomeStage;
  action(action: PolicyAction): OutcomeStage;
  actions(actions: PolicyAction[]): OutcomeStage;
  level(): LevelBuilder;
  tokenBudget(max: number): OutcomeStage;
  rateLimit(maxActions: number, windowMs: number): OutcomeStage;
  injection(threshold?: number): OutcomeStage;
  custom(type: string, params: Record<string, unknown>): OutcomeStage;
}

interface LevelBuilder {
  below(level: number): OutcomeStage;
  above(level: number): OutcomeStage;
}

interface OutcomeStage {
  then(): OutcomeBuilder;
}

interface OutcomeBuilder {
  block(reason: string): RuleBuilder;
  allow(reason: string): RuleBuilder;
  warn(reason: string): RuleBuilder;
  requireApproval(reason: string): RuleBuilder;
}

interface RuleBuilder extends PolicyRule {
  withPriority(priority: number): RuleBuilder;
  withStage(stage: PolicyStage): RuleBuilder;
  withId(id: string): RuleBuilder;
  withName(name: string): RuleBuilder;
  disabled(): RuleBuilder;
}

// ─── Implementation ─────────────────────────────────────────

let ruleCounter = 0;

/** Start building a policy rule with the fluent DSL */
export function when(): ConditionBuilder {
  return {
    tool(name: string): OutcomeStage {
      return createOutcomeStage({ type: "tool_blocked", params: { tools: [name] } });
    },
    tools(names: string[]): OutcomeStage {
      return createOutcomeStage({ type: "tool_blocked", params: { tools: names } });
    },
    action(action: PolicyAction): OutcomeStage {
      return createOutcomeStage({ type: "action_type", params: { actions: [action] } });
    },
    actions(actions: PolicyAction[]): OutcomeStage {
      return createOutcomeStage({ type: "action_type", params: { actions } });
    },
    level(): LevelBuilder {
      return {
        below(level: number): OutcomeStage {
          return createOutcomeStage({ type: "agent_level", params: { minLevel: level } });
        },
        above(level: number): OutcomeStage {
          return createOutcomeStage({
            type: "not",
            params: { condition: { type: "agent_level", params: { minLevel: level + 1 } } },
          });
        },
      };
    },
    tokenBudget(max: number): OutcomeStage {
      return createOutcomeStage({ type: "token_limit", params: { maxTokens: max } });
    },
    rateLimit(maxActions: number, windowMs: number): OutcomeStage {
      return createOutcomeStage({ type: "rate_limit", params: { maxActions, windowMs } });
    },
    injection(threshold = 0.5): OutcomeStage {
      return createOutcomeStage({ type: "injection_guard", params: { threshold } });
    },
    custom(type: string, params: Record<string, unknown>): OutcomeStage {
      return createOutcomeStage({ type, params });
    },
  };
}

function createOutcomeStage(condition: { type: string; params: Record<string, unknown> }): OutcomeStage {
  return {
    then(): OutcomeBuilder {
      return {
        block: (reason) => buildRule(condition, "block", reason),
        allow: (reason) => buildRule(condition, "allow", reason),
        warn: (reason) => buildRule(condition, "warn", reason),
        requireApproval: (reason) => buildRule(condition, "require_approval", reason),
      };
    },
  };
}

function buildRule(
  condition: { type: string; params: Record<string, unknown> },
  outcome: PolicyRule["outcome"],
  reason: string,
): RuleBuilder {
  ruleCounter++;
  const rule: PolicyRule = {
    id: `dsl-rule-${ruleCounter}`,
    name: `${outcome}: ${reason.slice(0, 50)}`,
    condition,
    outcome,
    reason,
    priority: 50,
    enabled: true,
  };

  const builder: RuleBuilder = Object.assign({}, rule, {
    withPriority(priority: number): RuleBuilder {
      builder.priority = priority;
      return builder;
    },
    withStage(stage: PolicyStage): RuleBuilder {
      builder.stage = stage;
      return builder;
    },
    withId(id: string): RuleBuilder {
      builder.id = id;
      return builder;
    },
    withName(name: string): RuleBuilder {
      builder.name = name;
      return builder;
    },
    disabled(): RuleBuilder {
      builder.enabled = false;
      return builder;
    },
  });

  return builder;
}
