import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPolicyEngine } from "./policy";
import type { PolicyRule, EnforcementContext } from "./policy";

function makeCtx(overrides: Partial<EnforcementContext> = {}): EnforcementContext {
  return { agentId: "agent-1", action: "tool_call", ...overrides };
}

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: overrides.id ?? "test-rule",
    name: overrides.name ?? "Test rule",
    condition: overrides.condition ?? { type: "tool_blocked", params: { tools: ["danger"] } },
    outcome: overrides.outcome ?? "block",
    reason: overrides.reason ?? "Test reason",
    priority: overrides.priority ?? 100,
    enabled: overrides.enabled ?? true,
    stage: overrides.stage,
  };
}

describe("Condition Registry (instance-scoped)", () => {
  test("registerCondition adds a condition type", () => {
    const engine = createPolicyEngine();
    engine.registerCondition({
      name: "geo_fence",
      description: "Block actions outside allowed regions",
      evaluator: () => false,
    });
    const entry = engine.getRegisteredCondition("geo_fence");
    assert.ok(entry);
    assert.equal(entry.name, "geo_fence");
    assert.equal(entry.description, "Block actions outside allowed regions");
  });

  test("registerCondition throws on duplicate name", () => {
    const engine = createPolicyEngine();
    engine.registerCondition({
      name: "geo_fence",
      description: "First",
      evaluator: () => false,
    });
    assert.throws(
      () => engine.registerCondition({ name: "geo_fence", description: "Second", evaluator: () => false }),
      /already registered/,
    );
  });

  test("unregisterCondition removes a condition type", () => {
    const engine = createPolicyEngine();
    engine.registerCondition({ name: "temp", description: "Temporary", evaluator: () => false });
    assert.equal(engine.unregisterCondition("temp"), true);
    assert.equal(engine.getRegisteredCondition("temp"), undefined);
  });

  test("unregisterCondition returns false for unknown names", () => {
    const engine = createPolicyEngine();
    assert.equal(engine.unregisterCondition("nonexistent"), false);
  });

  test("getRegisteredConditions includes builtins by default", () => {
    const engine = createPolicyEngine();
    const all = engine.getRegisteredConditions();
    // Should have all 24 built-in conditions
    assert.ok(all.length >= 24);
    assert.ok(all.some((c) => c.name === "tool_blocked"));
    assert.ok(all.some((c) => c.name === "injection_guard"));
  });

  test("getRegisteredConditions includes custom + builtins", () => {
    const engine = createPolicyEngine();
    engine.registerCondition({ name: "a", description: "A", evaluator: () => false });
    engine.registerCondition({ name: "b", description: "B", evaluator: () => true });
    const all = engine.getRegisteredConditions();
    assert.ok(all.some((c) => c.name === "a"));
    assert.ok(all.some((c) => c.name === "b"));
    assert.ok(all.some((c) => c.name === "tool_blocked")); // builtins still present
  });

  test("clearConditionRegistry removes all entries", () => {
    const engine = createPolicyEngine();
    engine.registerCondition({ name: "a", description: "A", evaluator: () => false });
    engine.clearConditionRegistry();
    assert.equal(engine.getRegisteredConditions().length, 0);
  });

  test("clearConditionRegistry with keepBuiltins re-registers builtins", () => {
    const engine = createPolicyEngine();
    engine.registerCondition({ name: "custom", description: "Custom", evaluator: () => false });
    engine.clearConditionRegistry({ keepBuiltins: true });
    // Custom should be gone, builtins should remain
    assert.equal(engine.getRegisteredCondition("custom"), undefined);
    assert.ok(engine.getRegisteredCondition("tool_blocked"));
  });

  test("paramSchema is stored when provided", () => {
    const engine = createPolicyEngine();
    const schema = { type: "object", properties: { regions: { type: "array" } } };
    engine.registerCondition({
      name: "geo_fence",
      description: "Geo fence",
      evaluator: () => false,
      paramSchema: schema,
    });
    const entry = engine.getRegisteredCondition("geo_fence");
    assert.deepEqual(entry?.paramSchema, schema);
  });

  test("conditions are isolated between engine instances", () => {
    const engine1 = createPolicyEngine();
    const engine2 = createPolicyEngine();

    engine1.registerCondition({
      name: "tenant_a_check",
      description: "Tenant A custom condition",
      evaluator: () => true,
    });

    // engine2 should NOT have engine1's custom condition
    assert.ok(engine1.getRegisteredCondition("tenant_a_check"));
    assert.equal(engine2.getRegisteredCondition("tenant_a_check"), undefined);
  });

  test("conditions passed via config are registered on the instance", () => {
    const engine = createPolicyEngine({
      conditions: [
        { name: "from_config", description: "Config condition", evaluator: () => true },
      ],
    });
    assert.ok(engine.getRegisteredCondition("from_config"));

    // Another engine should not have it
    const engine2 = createPolicyEngine();
    assert.equal(engine2.getRegisteredCondition("from_config"), undefined);
  });
});

describe("Registered condition evaluation (instance-scoped)", () => {
  test("evaluates a registered condition that triggers", () => {
    const engine = createPolicyEngine({
      conditions: [{
        name: "high_cost",
        description: "Block when session cost exceeds threshold",
        evaluator: (_ctx, params) => {
          const threshold = params.maxCost as number;
          return (_ctx.sessionCost ?? 0) > threshold;
        },
      }],
      rules: [makeRule({
        id: "cost-check",
        condition: { type: "high_cost", params: { maxCost: 10 } },
      })],
    });

    const blocked = engine.evaluate(makeCtx({ sessionCost: 15 }));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.ruleId, "cost-check");

    const allowed = engine.evaluate(makeCtx({ sessionCost: 5 }));
    assert.equal(allowed.blocked, false);
  });

  test("evaluates a registered condition using metadata", () => {
    const engine = createPolicyEngine({
      conditions: [{
        name: "geo_fence",
        description: "Block actions outside allowed regions",
        evaluator: (ctx, params) => {
          const region = (ctx.metadata?.region as string) ?? "";
          const allowed = params.allowedRegions as string[];
          return region.length > 0 && !allowed.includes(region);
        },
      }],
      rules: [makeRule({
        id: "geo-rule",
        condition: { type: "geo_fence", params: { allowedRegions: ["us", "eu"] } },
      })],
    });

    const blocked = engine.evaluate(makeCtx({ metadata: { region: "cn" } }));
    assert.equal(blocked.blocked, true);

    const allowed = engine.evaluate(makeCtx({ metadata: { region: "us" } }));
    assert.equal(allowed.blocked, false);
  });

  test("throws when condition type is not registered", () => {
    const engine = createPolicyEngine({
      rules: [makeRule({
        condition: { type: "nonexistent", params: {} },
      })],
    });
    engine.clearConditionRegistry();

    assert.throws(
      () => engine.evaluate(makeCtx()),
      /Unknown condition type "nonexistent"/,
    );
  });

  test("registered conditions work with any_of combinator", () => {
    const engine = createPolicyEngine({
      conditions: [{
        name: "is_weekend",
        description: "Check if metadata says weekend",
        evaluator: (ctx) => (ctx.metadata?.isWeekend as boolean) === true,
      }],
      rules: [makeRule({
        id: "combo",
        condition: {
          type: "any_of",
          params: {
            conditions: [
              { type: "tool_blocked", params: { tools: ["danger"] } },
              { type: "is_weekend", params: {} },
            ],
          },
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
    const engine = createPolicyEngine({
      conditions: [{
        name: "vip_user",
        description: "Check if user is VIP",
        evaluator: (ctx) => (ctx.metadata?.vip as boolean) === true,
      }],
      rules: [makeRule({
        id: "non-vip-block",
        condition: { type: "not", params: { condition: { type: "vip_user", params: {} } } },
      })],
    });

    const vipAllowed = engine.evaluate(makeCtx({ metadata: { vip: true } }));
    assert.equal(vipAllowed.blocked, false);

    const nonVipBlocked = engine.evaluate(makeCtx({ metadata: { vip: false } }));
    assert.equal(nonVipBlocked.blocked, true);
  });

  test("registered conditions work with evaluateStage", () => {
    const engine = createPolicyEngine({
      conditions: [{
        name: "output_check",
        description: "Check output for forbidden content",
        evaluator: (ctx, params) => {
          const forbidden = params.forbidden as string;
          return (ctx.outputText ?? "").includes(forbidden);
        },
      }],
      rules: [makeRule({
        id: "post-check",
        stage: "postprocess",
        condition: { type: "output_check", params: { forbidden: "SECRET" } },
      })],
    });

    const blocked = engine.evaluateStage(makeCtx({ outputText: "contains SECRET data" }), "postprocess");
    assert.equal(blocked.blocked, true);

    const allowed = engine.evaluateStage(makeCtx({ outputText: "safe output" }), "postprocess");
    assert.equal(allowed.blocked, false);
  });

  test("registered condition with addRule after engine creation", () => {
    const engine = createPolicyEngine();
    engine.registerCondition({
      name: "always_block",
      description: "Always triggers",
      evaluator: () => true,
    });

    assert.equal(engine.evaluate(makeCtx()).blocked, false);

    engine.addRule(makeRule({
      id: "dynamic",
      condition: { type: "always_block", params: {} },
    }));

    assert.equal(engine.evaluate(makeCtx()).blocked, true);
  });
});
