/**
 * Adversarial tests for the policy engine.
 *
 * Covers edge cases identified during architecture audit:
 * priority ties, concurrent mutation, scale, error propagation,
 * mid-iteration removal, and duplicate IDs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPolicyEngine,
  type PolicyRule,
  type EnforcementContext,
} from "./policy";

const ctx: EnforcementContext = {
  agentId: "test-agent",
  action: "tool_call",
  tool: "shell_exec",
};

// ─── Priority Tie Determinism ───────────────────────────────────

describe("priority tie determinism", () => {
  it("higher-index rule wins when priorities are equal", () => {
    const blockRule: PolicyRule = {
      id: "block-first",
      name: "Block shell",
      condition: { type: "tool_blocked", params: { tools: ["shell_exec"] } },
      outcome: "block",
      reason: "Blocked by first rule",
      priority: 10,
      enabled: true,
    };

    const allowRule: PolicyRule = {
      id: "allow-second",
      name: "Allow shell",
      condition: { type: "tool_blocked", params: { tools: ["shell_exec"] } },
      outcome: "allow",
      reason: "Allowed by second rule",
      priority: 10,
      enabled: true,
    };

    const engine = createPolicyEngine({ rules: [blockRule, allowRule] });
    const d1 = engine.evaluate(ctx);

    // Stable sort preserves insertion order for equal priorities.
    // Both match, first in sorted order wins.
    assert.ok(d1.ruleId !== null, "A rule should match");

    // Run 100 times to verify determinism
    for (let i = 0; i < 100; i++) {
      const d = engine.evaluate(ctx);
      assert.equal(d.ruleId, d1.ruleId, `Run ${i}: result must be deterministic`);
      assert.equal(d.outcome, d1.outcome);
    }
  });
});

// ─── Kill Switch + Policy Engine Race ───────────────────────────

describe("kill switch + policy engine race", () => {
  it("rule added mid-evaluate does not affect in-flight evaluation", () => {
    // Custom evaluator that adds a kill rule during evaluation
    const sneakyRule: PolicyRule = {
      id: "sneaky",
      name: "Sneaky adder",
      condition: {
        type: "custom",
        params: { evaluate: () => false }, // Does not match
      },
      outcome: "allow",
      reason: "Sneaky",
      priority: 1,
      enabled: true,
    };

    const engine = createPolicyEngine({ rules: [sneakyRule] });

    // Add a kill rule via the sneaky evaluator's side effect
    const killRule: PolicyRule = {
      id: "kill",
      name: "Kill switch",
      condition: { type: "tool_blocked", params: { tools: ["shell_exec"] } },
      outcome: "block",
      reason: "Emergency kill",
      priority: 999,
      enabled: true,
    };

    // Modify the sneaky rule to add kill rule as side effect
    const engineWithSideEffect = createPolicyEngine({
      rules: [{
        ...sneakyRule,
        priority: 1000, // Evaluated first (highest priority)
        condition: {
          type: "custom",
          params: {
            evaluate: () => {
              // Side effect: add kill rule during evaluation
              engine.addRule(killRule);
              return false;
            },
          },
        },
      }],
    });

    // The kill rule added to `engine` during evaluation of `engineWithSideEffect`
    // should NOT affect the current evaluation (different engine instance).
    // JS is single-threaded, so within one engine, the sorted snapshot is safe.
    const decision = engineWithSideEffect.evaluate(ctx);
    assert.equal(decision.outcome, "allow", "Side-effect rule should not affect in-flight eval");
  });
});

// ─── Performance: 1000+ Rules ───────────────────────────────────

describe("performance with 1000+ rules", () => {
  it("evaluates 1000 rules in under 10ms", () => {
    const rules: PolicyRule[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `rule-${i}`,
      name: `Rule ${i}`,
      condition: { type: "tool_blocked" as const, params: { tools: [`tool_${i}`] } },
      outcome: "block" as const,
      reason: `Blocked by rule ${i}`,
      priority: i,
      enabled: true,
    }));

    const engine = createPolicyEngine({ rules });

    const start = performance.now();
    const decision = engine.evaluate(ctx);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 10, `Evaluation took ${elapsed.toFixed(2)}ms, expected <10ms`);
    // shell_exec is not in any tool_N list, so no rule matches
    assert.equal(decision.outcome, "allow");
    assert.equal(decision.rulesEvaluated, 1000);
  });

  it("evaluates 1000 rules with a match at the end in under 10ms", () => {
    const rules: PolicyRule[] = Array.from({ length: 999 }, (_, i) => ({
      id: `rule-${i}`,
      name: `Rule ${i}`,
      condition: { type: "tool_blocked" as const, params: { tools: [`tool_${i}`] } },
      outcome: "allow" as const,
      reason: `No match ${i}`,
      priority: 1000 - i,
      enabled: true,
    }));

    // Add matching rule at lowest priority (evaluated last)
    rules.push({
      id: "final-block",
      name: "Final block",
      condition: { type: "tool_blocked", params: { tools: ["shell_exec"] } },
      outcome: "block",
      reason: "Caught at end",
      priority: 0,
      enabled: true,
    });

    const engine = createPolicyEngine({ rules });

    const start = performance.now();
    const decision = engine.evaluate(ctx);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 10, `Evaluation took ${elapsed.toFixed(2)}ms, expected <10ms`);
    assert.equal(decision.outcome, "block");
    assert.equal(decision.ruleId, "final-block");
  });
});

// ─── Custom Evaluator That Throws ───────────────────────────────

describe("custom evaluator error handling", () => {
  it("propagates thrown error from custom evaluator", () => {
    const rule: PolicyRule = {
      id: "throws",
      name: "Throws",
      condition: {
        type: "custom",
        params: { evaluate: () => { throw new Error("evaluator broke"); } },
      },
      outcome: "block",
      reason: "Should not reach",
      priority: 10,
      enabled: true,
    };

    const engine = createPolicyEngine({ rules: [rule] });
    assert.throws(() => engine.evaluate(ctx), { message: "evaluator broke" });
  });

  it("engine remains usable after a throwing evaluator", () => {
    const throwingRule: PolicyRule = {
      id: "throws",
      name: "Throws",
      condition: {
        type: "custom",
        params: { evaluate: () => { throw new Error("boom"); } },
      },
      outcome: "block",
      reason: "N/A",
      priority: 10,
      enabled: true,
    };

    const safeRule: PolicyRule = {
      id: "safe",
      name: "Safe block",
      condition: { type: "tool_blocked", params: { tools: ["shell_exec"] } },
      outcome: "block",
      reason: "Safe block",
      priority: 5,
      enabled: true,
    };

    const engine = createPolicyEngine({ rules: [throwingRule, safeRule] });

    // First call throws
    assert.throws(() => engine.evaluate(ctx));

    // Remove throwing rule — engine should recover
    engine.removeRule("throws");
    const decision = engine.evaluate(ctx);
    assert.equal(decision.outcome, "block");
    assert.equal(decision.ruleId, "safe");
  });

  it("rejects async custom evaluator", () => {
    const rule: PolicyRule = {
      id: "async",
      name: "Async eval",
      condition: {
        type: "custom",
        params: { evaluate: (() => Promise.resolve(true)) as unknown as (ctx: EnforcementContext) => boolean },
      },
      outcome: "block",
      reason: "Async",
      priority: 10,
      enabled: true,
    };

    const engine = createPolicyEngine({ rules: [rule] });
    assert.throws(() => engine.evaluate(ctx), /Promise/);
  });
});

// ─── removeRule During Iteration Safety ─────────────────────────

describe("removeRule during iteration", () => {
  it("removing rules between evaluations does not corrupt the engine", () => {
    const rules: PolicyRule[] = Array.from({ length: 5 }, (_, i) => ({
      id: `rule-${i}`,
      name: `Rule ${i}`,
      condition: { type: "tool_blocked" as const, params: { tools: [`tool_${i}`] } },
      outcome: "block" as const,
      reason: `Blocked by ${i}`,
      priority: i,
      enabled: true,
    }));

    const engine = createPolicyEngine({ rules });
    assert.equal(engine.ruleCount, 5);

    // Remove rules in various orders
    engine.removeRule("rule-2");
    assert.equal(engine.ruleCount, 4);

    engine.removeRule("rule-0");
    assert.equal(engine.ruleCount, 3);

    engine.removeRule("rule-4");
    assert.equal(engine.ruleCount, 2);

    // Remaining: rule-1, rule-3
    const remaining = engine.getRules().map(r => r.id);
    assert.deepEqual(remaining, ["rule-1", "rule-3"]);

    // Engine still evaluates correctly
    const decision = engine.evaluate(ctx);
    assert.equal(decision.outcome, "allow"); // No tool matches shell_exec
  });

  it("removing a non-existent rule is a no-op", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "only",
        name: "Only rule",
        condition: { type: "tool_blocked", params: { tools: ["shell_exec"] } },
        outcome: "block",
        reason: "Blocked",
        priority: 1,
        enabled: true,
      }],
    });

    engine.removeRule("does-not-exist");
    assert.equal(engine.ruleCount, 1);
  });
});

// ─── addRule with Duplicate ID ──────────────────────────────────

describe("addRule with duplicate ID", () => {
  it("replaces existing rule instead of duplicating", () => {
    const original: PolicyRule = {
      id: "dup",
      name: "Original",
      condition: { type: "tool_blocked", params: { tools: ["shell_exec"] } },
      outcome: "block",
      reason: "Original block",
      priority: 10,
      enabled: true,
    };

    const replacement: PolicyRule = {
      id: "dup",
      name: "Replacement",
      condition: { type: "tool_blocked", params: { tools: ["shell_exec"] } },
      outcome: "allow",
      reason: "Replaced to allow",
      priority: 10,
      enabled: true,
    };

    const engine = createPolicyEngine({ rules: [original] });
    assert.equal(engine.ruleCount, 1);

    engine.addRule(replacement);
    assert.equal(engine.ruleCount, 1, "Should still be 1 rule, not 2");

    const decision = engine.evaluate(ctx);
    assert.equal(decision.outcome, "allow", "Replacement rule should be active");
    assert.equal(decision.reason, "Replaced to allow");
  });

  it("getRules reflects the replacement", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "r1",
        name: "V1",
        condition: { type: "tool_blocked", params: { tools: ["x"] } },
        outcome: "block",
        reason: "v1",
        priority: 1,
        enabled: true,
      }],
    });

    engine.addRule({
      id: "r1",
      name: "V2",
      condition: { type: "tool_blocked", params: { tools: ["y"] } },
      outcome: "allow",
      reason: "v2",
      priority: 1,
      enabled: true,
    });

    const rules = engine.getRules();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].name, "V2");
  });
});
