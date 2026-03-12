import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPolicyEngine,
  registerCondition,
  unregisterCondition,
  getRegisteredCondition,
  getRegisteredConditions,
  clearConditionRegistry,
} from "./policy";
import type { PolicyRule, EnforcementContext } from "./policy";

function makeCtx(overrides: Partial<EnforcementContext> = {}): EnforcementContext {
  return { agentId: "agent-1", action: "tool_call", ...overrides };
}

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: overrides.id ?? "test-rule",
    name: overrides.name ?? "Test rule",
    condition: overrides.condition ?? { type: "tool_blocked", tools: ["danger"] },
    outcome: overrides.outcome ?? "block",
    reason: overrides.reason ?? "Test reason",
    priority: overrides.priority ?? 100,
    enabled: overrides.enabled ?? true,
    stage: overrides.stage,
  };
}

describe("Condition Registry", () => {
  beforeEach(() => {
    clearConditionRegistry();
  });

  test("registerCondition adds a condition type", () => {
    registerCondition({
      name: "geo_fence",
      description: "Block actions outside allowed regions",
      evaluator: () => false,
    });
    const entry = getRegisteredCondition("geo_fence");
    assert.ok(entry);
    assert.equal(entry.name, "geo_fence");
    assert.equal(entry.description, "Block actions outside allowed regions");
  });

  test("registerCondition throws on duplicate name", () => {
    registerCondition({
      name: "geo_fence",
      description: "First",
      evaluator: () => false,
    });
    assert.throws(
      () => registerCondition({ name: "geo_fence", description: "Second", evaluator: () => false }),
      /already registered/,
    );
  });

  test("unregisterCondition removes a condition type", () => {
    registerCondition({ name: "temp", description: "Temporary", evaluator: () => false });
    assert.equal(unregisterCondition("temp"), true);
    assert.equal(getRegisteredCondition("temp"), undefined);
  });

  test("unregisterCondition returns false for unknown names", () => {
    assert.equal(unregisterCondition("nonexistent"), false);
  });

  test("getRegisteredConditions returns all entries", () => {
    registerCondition({ name: "a", description: "A", evaluator: () => false });
    registerCondition({ name: "b", description: "B", evaluator: () => true });
    const all = getRegisteredConditions();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((e) => e.name).sort(), ["a", "b"]);
  });

  test("clearConditionRegistry removes all entries", () => {
    registerCondition({ name: "a", description: "A", evaluator: () => false });
    registerCondition({ name: "b", description: "B", evaluator: () => false });
    clearConditionRegistry();
    assert.equal(getRegisteredConditions().length, 0);
  });

  test("paramSchema is stored when provided", () => {
    const schema = { type: "object", properties: { regions: { type: "array" } } };
    registerCondition({
      name: "geo_fence",
      description: "Geo fence",
      evaluator: () => false,
      paramSchema: schema,
    });
    const entry = getRegisteredCondition("geo_fence");
    assert.deepEqual(entry?.paramSchema, schema);
  });
});

describe("Registered condition evaluation", () => {
  beforeEach(() => {
    clearConditionRegistry();
  });

  test("evaluates a registered condition that triggers", () => {
    registerCondition({
      name: "high_cost",
      description: "Block when session cost exceeds threshold",
      evaluator: (_ctx, params) => {
        const threshold = params.maxCost as number;
        return (_ctx.sessionCost ?? 0) > threshold;
      },
    });

    const engine = createPolicyEngine({
      rules: [makeRule({
        id: "cost-check",
        condition: { type: "registered", name: "high_cost", params: { maxCost: 10 } },
      })],
    });

    const blocked = engine.evaluate(makeCtx({ sessionCost: 15 }));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.ruleId, "cost-check");

    const allowed = engine.evaluate(makeCtx({ sessionCost: 5 }));
    assert.equal(allowed.blocked, false);
  });

  test("evaluates a registered condition using metadata", () => {
    registerCondition({
      name: "geo_fence",
      description: "Block actions outside allowed regions",
      evaluator: (ctx, params) => {
        const region = (ctx.metadata?.region as string) ?? "";
        const allowed = params.allowedRegions as string[];
        return region.length > 0 && !allowed.includes(region);
      },
    });

    const engine = createPolicyEngine({
      rules: [makeRule({
        id: "geo-rule",
        condition: { type: "registered", name: "geo_fence", params: { allowedRegions: ["us", "eu"] } },
      })],
    });

    const blocked = engine.evaluate(makeCtx({ metadata: { region: "cn" } }));
    assert.equal(blocked.blocked, true);

    const allowed = engine.evaluate(makeCtx({ metadata: { region: "us" } }));
    assert.equal(allowed.blocked, false);
  });

  test("throws when condition name is not registered", () => {
    const engine = createPolicyEngine({
      rules: [makeRule({
        condition: { type: "registered", name: "nonexistent", params: {} },
      })],
    });

    assert.throws(
      () => engine.evaluate(makeCtx()),
      /Unknown registered condition type "nonexistent"/,
    );
  });

  test("registered conditions work with any_of combinator", () => {
    registerCondition({
      name: "is_weekend",
      description: "Check if metadata says weekend",
      evaluator: (ctx) => (ctx.metadata?.isWeekend as boolean) === true,
    });

    const engine = createPolicyEngine({
      rules: [makeRule({
        id: "combo",
        condition: {
          type: "any_of",
          conditions: [
            { type: "tool_blocked", tools: ["danger"] },
            { type: "registered", name: "is_weekend", params: {} },
          ],
        },
      })],
    });

    const weekendBlock = engine.evaluate(makeCtx({ tool: "safe_tool", metadata: { isWeekend: true } }));
    assert.equal(weekendBlock.blocked, true);

    const toolBlock = engine.evaluate(makeCtx({ tool: "danger" }));
    assert.equal(toolBlock.blocked, true);

    const noBlock = engine.evaluate(makeCtx({ tool: "safe_tool", metadata: { isWeekend: false } }));
    assert.equal(noBlock.blocked, false);
  });

  test("registered conditions work with not combinator", () => {
    registerCondition({
      name: "vip_user",
      description: "Check if user is VIP",
      evaluator: (ctx) => (ctx.metadata?.vip as boolean) === true,
    });

    const engine = createPolicyEngine({
      rules: [makeRule({
        id: "non-vip-block",
        condition: { type: "not", condition: { type: "registered", name: "vip_user", params: {} } },
      })],
    });

    const vipAllowed = engine.evaluate(makeCtx({ metadata: { vip: true } }));
    assert.equal(vipAllowed.blocked, false);

    const nonVipBlocked = engine.evaluate(makeCtx({ metadata: { vip: false } }));
    assert.equal(nonVipBlocked.blocked, true);
  });

  test("registered conditions work with evaluateStage", () => {
    registerCondition({
      name: "output_check",
      description: "Check output for forbidden content",
      evaluator: (ctx, params) => {
        const forbidden = params.forbidden as string;
        return (ctx.outputText ?? "").includes(forbidden);
      },
    });

    const engine = createPolicyEngine({
      rules: [makeRule({
        id: "post-check",
        stage: "postprocess",
        condition: { type: "registered", name: "output_check", params: { forbidden: "SECRET" } },
      })],
    });

    const blocked = engine.evaluateStage(makeCtx({ outputText: "contains SECRET data" }), "postprocess");
    assert.equal(blocked.blocked, true);

    const allowed = engine.evaluateStage(makeCtx({ outputText: "safe output" }), "postprocess");
    assert.equal(allowed.blocked, false);
  });

  test("registered condition with addRule after engine creation", () => {
    registerCondition({
      name: "always_block",
      description: "Always triggers",
      evaluator: () => true,
    });

    const engine = createPolicyEngine();
    assert.equal(engine.evaluate(makeCtx()).blocked, false);

    engine.addRule(makeRule({
      id: "dynamic",
      condition: { type: "registered", name: "always_block", params: {} },
    }));

    assert.equal(engine.evaluate(makeCtx()).blocked, true);
  });
});
