import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPolicyEngine,
  blockTools,
  allowOnlyTools,
  requireApproval,
  tokenBudget,
  rateLimit,
  requireLevel,
  requireSequence,
  timeWindow,
} from "./policy";
import type { PolicyRule, PolicyCondition, EnforcementContext } from "./policy";

// ─── Rule Management ────────────────────────────────────────────

describe("policy engine rule management", () => {
  test("addRule with duplicate ID replaces existing rule", () => {
    const engine = createPolicyEngine({
      rules: [blockTools(["shell_exec"])],
    });

    const ruleId = "block-tools-shell_exec";
    assert.equal(engine.ruleCount, 1);

    // Add rule with same ID but different tools
    engine.addRule({
      id: ruleId,
      name: "Updated block",
      condition: { type: "tool_blocked", params: { tools: ["new_tool"] } },
      outcome: "block",
      reason: "Updated reason",
      priority: 100,
      enabled: true,
    });

    assert.equal(engine.ruleCount, 1);
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "new_tool",
    });
    assert.ok(decision.blocked);
  });

  test("removeRule for non-existent ID is no-op", () => {
    const engine = createPolicyEngine({
      rules: [blockTools(["shell_exec"])],
    });

    assert.equal(engine.ruleCount, 1);
    engine.removeRule("does-not-exist");
    assert.equal(engine.ruleCount, 1);
  });

  test("getRules returns copy, not reference", () => {
    const engine = createPolicyEngine({
      rules: [blockTools(["shell_exec"])],
    });

    const rules = engine.getRules();
    rules.push(blockTools(["dangerous"]));

    // Original engine should be unaffected
    assert.equal(engine.ruleCount, 1);
  });

  test("disabled rules are not evaluated", () => {
    const rule = blockTools(["shell_exec"]);
    rule.enabled = false;

    const engine = createPolicyEngine({ rules: [rule] });

    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "shell_exec",
    });
    assert.ok(!decision.blocked);
  });

  test("ruleCount only counts enabled rules", () => {
    const rule1 = blockTools(["a"]);
    const rule2 = blockTools(["b"]);
    rule2.enabled = false;

    const engine = createPolicyEngine({ rules: [rule1, rule2] });
    assert.equal(engine.ruleCount, 1);
  });
});

// ─── Priority Ordering ──────────────────────────────────────────

describe("policy priority ordering", () => {
  test("higher priority rule wins over lower", () => {
    const allow: PolicyRule = {
      id: "allow-all",
      name: "Allow everything",
      condition: { type: "custom", params: { evaluate: () => true } },
      outcome: "allow",
      reason: "Allowed",
      priority: 200,
      enabled: true,
    };

    const block = blockTools(["shell_exec"]); // priority 100

    const engine = createPolicyEngine({ rules: [block, allow] });

    // Allow rule has higher priority, matches first
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "shell_exec",
    });
    assert.ok(!decision.blocked);
  });

  test("equal priority uses insertion order", () => {
    const block1 = blockTools(["a"]);
    block1.id = "rule1";
    block1.priority = 100;

    const block2 = blockTools(["b"]);
    block2.id = "rule2";
    block2.priority = 100;

    const engine = createPolicyEngine({ rules: [block1, block2] });

    // Both have same priority, but sort is stable — first one wins
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "a",
    });
    assert.ok(decision.blocked);
    assert.equal(decision.ruleId, "rule1");
  });
});

// ─── Default Outcome ────────────────────────────────────────────

describe("default outcome", () => {
  test("defaults to allow when no rules match", () => {
    const engine = createPolicyEngine({});
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "anything",
    });
    assert.ok(!decision.blocked);
    assert.equal(decision.outcome, "allow");
    assert.equal(decision.ruleId, null);
  });

  test("can default to block when configured", () => {
    const engine = createPolicyEngine({ defaultOutcome: "block" });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "anything",
    });
    assert.ok(decision.blocked);
    assert.equal(decision.outcome, "block");
  });

  test("decision includes rulesEvaluated count", () => {
    const engine = createPolicyEngine({
      rules: [blockTools(["a"]), blockTools(["b"]), blockTools(["c"])],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "a",
    });
    assert.equal(decision.rulesEvaluated, 3);
  });

  test("decision includes evaluatedAt timestamp", () => {
    const engine = createPolicyEngine();
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
    });
    assert.ok(decision.evaluatedAt);
    assert.ok(!isNaN(Date.parse(decision.evaluatedAt)));
  });
});

// ─── Condition Edge Cases ───────────────────────────────────────

describe("tool_blocked edge cases", () => {
  test("no tool in context means no match", () => {
    const engine = createPolicyEngine({
      rules: [blockTools(["shell_exec"])],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      // no tool specified
    });
    assert.ok(!decision.blocked);
  });

  test("empty tools array never matches", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "empty-block",
        name: "Empty block",
        condition: { type: "tool_blocked", params: { tools: [] } },
        outcome: "block",
        reason: "Empty list",
        priority: 100,
        enabled: true,
      }],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "anything",
    });
    assert.ok(!decision.blocked);
  });
});

describe("tool_allowed (allowlist) edge cases", () => {
  test("blocks tools NOT in allowlist", () => {
    const engine = createPolicyEngine({
      rules: [allowOnlyTools(["search", "read"])],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "delete",
    });
    assert.ok(decision.blocked);
  });

  test("allows tools IN allowlist", () => {
    const engine = createPolicyEngine({
      rules: [allowOnlyTools(["search", "read"])],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      tool: "search",
    });
    assert.ok(!decision.blocked);
  });
});

describe("data_classification condition", () => {
  test("blocks when input contains classified data", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "block-pii",
        name: "Block PII",
        condition: { type: "data_classification", params: { blocked: ["ssn", "credit_card"] } },
        outcome: "block",
        reason: "PII detected",
        priority: 100,
        enabled: true,
      }],
    });

    const decision = engine.evaluate({
      agentId: "a1",
      action: "data_access",
      input: { field: "user_ssn_number" },
    });
    assert.ok(decision.blocked);
  });

  test("allows when no classified data in input", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "block-pii",
        name: "Block PII",
        condition: { type: "data_classification", params: { blocked: ["ssn"] } },
        outcome: "block",
        reason: "PII detected",
        priority: 100,
        enabled: true,
      }],
    });

    const decision = engine.evaluate({
      agentId: "a1",
      action: "data_access",
      input: { field: "user_name" },
    });
    assert.ok(!decision.blocked);
  });

  test("no input means no match", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "block-pii",
        name: "Block PII",
        condition: { type: "data_classification", params: { blocked: ["ssn"] } },
        outcome: "block",
        reason: "PII detected",
        priority: 100,
        enabled: true,
      }],
    });

    const decision = engine.evaluate({
      agentId: "a1",
      action: "data_access",
    });
    assert.ok(!decision.blocked);
  });

  test("case-insensitive matching", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "block-pii",
        name: "Block PII",
        condition: { type: "data_classification", params: { blocked: ["SSN"] } },
        outcome: "block",
        reason: "PII detected",
        priority: 100,
        enabled: true,
      }],
    });

    const decision = engine.evaluate({
      agentId: "a1",
      action: "data_access",
      input: { field: "user_ssn" },
    });
    assert.ok(decision.blocked);
  });
});

describe("token_limit edge cases", () => {
  test("undefined sessionTokensUsed defaults to 0", () => {
    const engine = createPolicyEngine({
      rules: [tokenBudget(1000)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      // sessionTokensUsed undefined
    });
    assert.ok(!decision.blocked);
  });

  test("exactly at limit is not blocked", () => {
    const engine = createPolicyEngine({
      rules: [tokenBudget(1000)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      sessionTokensUsed: 1000,
    });
    assert.ok(!decision.blocked);
  });

  test("one over limit is blocked", () => {
    const engine = createPolicyEngine({
      rules: [tokenBudget(1000)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      sessionTokensUsed: 1001,
    });
    assert.ok(decision.blocked);
  });
});

describe("rate_limit edge cases", () => {
  test("undefined recentActionCount defaults to 0", () => {
    const engine = createPolicyEngine({
      rules: [rateLimit(10, 60000)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
    });
    assert.ok(!decision.blocked);
  });

  test("exactly at limit is not blocked", () => {
    const engine = createPolicyEngine({
      rules: [rateLimit(10, 60000)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      recentActionCount: 10,
    });
    assert.ok(!decision.blocked);
  });

  test("one over limit is blocked", () => {
    const engine = createPolicyEngine({
      rules: [rateLimit(10, 60000)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      recentActionCount: 11,
    });
    assert.ok(decision.blocked);
  });
});

describe("agent_level edge cases", () => {
  test("undefined agentLevel defaults to 0", () => {
    const engine = createPolicyEngine({
      rules: [requireLevel(1)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      // agentLevel undefined
    });
    assert.ok(decision.blocked);
  });

  test("exactly at required level is not blocked", () => {
    const engine = createPolicyEngine({
      rules: [requireLevel(3)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      agentLevel: 3,
    });
    assert.ok(!decision.blocked);
  });

  test("above required level is not blocked", () => {
    const engine = createPolicyEngine({
      rules: [requireLevel(2)],
    });
    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
      agentLevel: 4,
    });
    assert.ok(!decision.blocked);
  });
});

describe("custom condition", () => {
  test("custom evaluator receives full context", () => {
    let receivedCtx: EnforcementContext | undefined;

    const engine = createPolicyEngine({
      rules: [{
        id: "custom",
        name: "Custom",
        condition: {
          type: "custom",
          params: {
            evaluate: (ctx) => {
              receivedCtx = ctx;
              return false;
            },
          },
        },
        outcome: "block",
        reason: "Custom",
        priority: 100,
        enabled: true,
      }],
    });

    engine.evaluate({
      agentId: "test-agent",
      action: "tool_call",
      tool: "my_tool",
      agentLevel: 3,
      metadata: { key: "value" },
    });

    assert.ok(receivedCtx);
    assert.equal(receivedCtx!.agentId, "test-agent");
    assert.equal(receivedCtx!.tool, "my_tool");
    assert.equal(receivedCtx!.agentLevel, 3);
  });

  test("custom evaluator returning true triggers rule", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "always-block",
        name: "Always block",
        condition: { type: "custom", params: { evaluate: () => true } },
        outcome: "block",
        reason: "Always blocked",
        priority: 100,
        enabled: true,
      }],
    });

    const decision = engine.evaluate({
      agentId: "a1",
      action: "tool_call",
    });
    assert.ok(decision.blocked);
  });
});

describe("require_approval outcome", () => {
  test("require_approval gates the action", () => {
    const engine = createPolicyEngine({
      rules: [requireApproval(["payment"])],
    });

    const decision = engine.evaluate({
      agentId: "a1",
      action: "payment",
    });

    // require_approval outcome gates the action (blocked=true)
    assert.equal(decision.blocked, true);
    assert.equal(decision.outcome, "require_approval");
  });
});

describe("warn outcome", () => {
  test("warn logs but does not block", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "warn-data-access",
        name: "Warn on data access",
        condition: { type: "action_type", params: { actions: ["data_access" as const] } },
        outcome: "warn" as const,
        reason: "Data access should be monitored",
        priority: 80,
        enabled: true,
      }],
    });

    const decision = engine.evaluate({
      agentId: "a1",
      action: "data_access",
    });

    assert.equal(decision.blocked, false);
    assert.equal(decision.outcome, "warn");
  });
});

// ─── Preset Builder Edge Cases ──────────────────────────────────

describe("preset builder configuration", () => {
  test("blockTools uses custom reason", () => {
    const rule = blockTools(["a"], "Custom reason");
    assert.equal(rule.reason, "Custom reason");
  });

  test("allowOnlyTools uses custom reason", () => {
    const rule = allowOnlyTools(["a"], "Only A");
    assert.equal(rule.reason, "Only A");
  });

  test("requireApproval uses custom reason", () => {
    const rule = requireApproval(["payment"], "Need approval");
    assert.equal(rule.reason, "Need approval");
  });

  test("requireSequence uses custom reason", () => {
    const rule = requireSequence("deploy", ["test"], "Must test first");
    assert.equal(rule.reason, "Must test first");
  });

  test("timeWindow uses custom reason", () => {
    const rule = timeWindow(9, 17, "Business hours only");
    assert.equal(rule.reason, "Business hours only");
  });

  test("all presets have unique IDs", () => {
    const rules = [
      blockTools(["a"]),
      allowOnlyTools(["b"]),
      requireApproval(["payment"]),
      tokenBudget(1000),
      rateLimit(10, 60000),
      requireLevel(2),
      requireSequence("deploy", ["test"]),
      timeWindow(9, 17),
    ];

    const ids = rules.map((r) => r.id);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, ids.length);
  });

  test("all presets are enabled by default", () => {
    const rules = [
      blockTools(["a"]),
      requireApproval(["payment"]),
      tokenBudget(1000),
      rateLimit(10, 60000),
      requireLevel(2),
    ];
    for (const rule of rules) {
      assert.equal(rule.enabled, true);
    }
  });
});
