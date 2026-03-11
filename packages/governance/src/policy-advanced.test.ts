import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPolicyEngine,
  blockTools,
  requireSequence,
  timeWindow,
} from "./policy";
import type { EnforcementContext, PolicyCondition } from "./policy";

describe("tool_sequence conditions", () => {
  it("blocks tool when required prior tool was not called", () => {
    const engine = createPolicyEngine({
      rules: [requireSequence("delete_record", ["backup_record"])],
    });

    const decision = engine.evaluate({
      agentId: "agent-1",
      action: "tool_call",
      tool: "delete_record",
      toolHistory: [],
    });

    assert.ok(decision.blocked);
    assert.ok(decision.reason.includes("backup_record"));
  });

  it("allows tool when required prior tool was called", () => {
    const engine = createPolicyEngine({
      rules: [requireSequence("delete_record", ["backup_record"])],
    });

    const decision = engine.evaluate({
      agentId: "agent-1",
      action: "tool_call",
      tool: "delete_record",
      toolHistory: ["backup_record"],
    });

    assert.ok(!decision.blocked);
  });

  it("requires ALL prior tools in sequence", () => {
    const engine = createPolicyEngine({
      rules: [requireSequence("deploy", ["test", "lint", "build"])],
    });

    // Only ran test and lint, not build
    const decision = engine.evaluate({
      agentId: "agent-1",
      action: "tool_call",
      tool: "deploy",
      toolHistory: ["test", "lint"],
    });

    assert.ok(decision.blocked);

    // Now with all three
    const decision2 = engine.evaluate({
      agentId: "agent-1",
      action: "tool_call",
      tool: "deploy",
      toolHistory: ["test", "lint", "build"],
    });

    assert.ok(!decision2.blocked);
  });

  it("does not affect other tools", () => {
    const engine = createPolicyEngine({
      rules: [requireSequence("delete_record", ["backup_record"])],
    });

    const decision = engine.evaluate({
      agentId: "agent-1",
      action: "tool_call",
      tool: "read_record",
      toolHistory: [],
    });

    assert.ok(!decision.blocked);
  });

  it("blocks when toolHistory is missing", () => {
    const engine = createPolicyEngine({
      rules: [requireSequence("delete_record", ["backup_record"])],
    });

    const decision = engine.evaluate({
      agentId: "agent-1",
      action: "tool_call",
      tool: "delete_record",
      // no toolHistory
    });

    assert.ok(decision.blocked);
  });
});

describe("any_of (OR combinator)", () => {
  it("matches when any sub-condition matches", () => {
    const condition: PolicyCondition = {
      type: "any_of",
      conditions: [
        { type: "tool_blocked", tools: ["shell_exec"] },
        { type: "tool_blocked", tools: ["database_drop"] },
      ],
    };

    const engine = createPolicyEngine({
      rules: [{
        id: "block-dangerous",
        name: "Block any dangerous tool",
        condition,
        outcome: "block",
        reason: "Dangerous tool",
        priority: 100,
        enabled: true,
      }],
    });

    const d1 = engine.evaluate({ agentId: "a", action: "tool_call", tool: "shell_exec" });
    assert.ok(d1.blocked);

    const d2 = engine.evaluate({ agentId: "a", action: "tool_call", tool: "database_drop" });
    assert.ok(d2.blocked);

    const d3 = engine.evaluate({ agentId: "a", action: "tool_call", tool: "safe_tool" });
    assert.ok(!d3.blocked);
  });
});

describe("all_of (AND combinator)", () => {
  it("matches only when all sub-conditions match", () => {
    const condition: PolicyCondition = {
      type: "all_of",
      conditions: [
        { type: "tool_blocked", tools: ["payment_send"] },
        { type: "agent_level", minLevel: 3 },
      ],
    };

    const engine = createPolicyEngine({
      rules: [{
        id: "high-risk",
        name: "Block low-level payment",
        condition,
        outcome: "block",
        reason: "Payment requires L3+",
        priority: 100,
        enabled: true,
      }],
    });

    // Tool matches but level is high enough — all_of fails because agent_level check passes (level >= 3)
    const d1 = engine.evaluate({ agentId: "a", action: "tool_call", tool: "payment_send", agentLevel: 3 });
    assert.ok(!d1.blocked); // agent_level condition returns false (not below min), so all_of = false

    // Tool matches AND level is too low — both conditions true
    const d2 = engine.evaluate({ agentId: "a", action: "tool_call", tool: "payment_send", agentLevel: 1 });
    assert.ok(d2.blocked);

    // Different tool — tool_blocked returns false, so all_of = false
    const d3 = engine.evaluate({ agentId: "a", action: "tool_call", tool: "safe_tool", agentLevel: 1 });
    assert.ok(!d3.blocked);
  });
});

describe("not combinator", () => {
  it("inverts a condition", () => {
    const condition: PolicyCondition = {
      type: "not",
      condition: { type: "tool_allowed", tools: ["safe_tool", "read_only"] },
    };

    const engine = createPolicyEngine({
      rules: [{
        id: "allow-safe-only",
        name: "Allow only safe tools (inverted)",
        condition,
        outcome: "allow",
        reason: "Tool is safe",
        priority: 100,
        enabled: true,
      }],
    });

    // tool_allowed blocks if tool NOT in list. not(that) = allow if NOT in list
    // safe_tool IS in list → tool_allowed returns false → not(false) = true → matches → allow
    const d1 = engine.evaluate({ agentId: "a", action: "tool_call", tool: "safe_tool" });
    assert.ok(!d1.blocked);
  });
});

describe("nested combinators", () => {
  it("supports deeply nested conditions", () => {
    // Block if: (tool is payment_send) AND (level < 3 OR no tool history)
    const condition: PolicyCondition = {
      type: "all_of",
      conditions: [
        { type: "tool_blocked", tools: ["payment_send"] },
        {
          type: "any_of",
          conditions: [
            { type: "agent_level", minLevel: 3 },
            { type: "tool_sequence", tool: "payment_send", requiredPrior: ["verify_identity"] },
          ],
        },
      ],
    };

    const engine = createPolicyEngine({
      rules: [{
        id: "complex-payment",
        name: "Complex payment rule",
        condition,
        outcome: "block",
        reason: "Payment requires L3 or identity verification",
        priority: 100,
        enabled: true,
      }],
    });

    // payment_send + low level + no verify → blocked
    const d1 = engine.evaluate({
      agentId: "a",
      action: "tool_call",
      tool: "payment_send",
      agentLevel: 1,
      toolHistory: [],
    });
    assert.ok(d1.blocked);

    // payment_send + high level → only first any_of fails (agent_level check passes)
    // but tool_sequence matches (no verify_identity in history) → any_of = true → all_of = true → blocked
    const d2 = engine.evaluate({
      agentId: "a",
      action: "tool_call",
      tool: "payment_send",
      agentLevel: 4,
      toolHistory: [],
    });
    // agent_level: minLevel 3, agentLevel 4 → 4 < 3 is false → not triggered
    // tool_sequence: requiredPrior ["verify_identity"] not in [] → true → triggered
    // any_of: false OR true = true
    // all_of: true AND true = true → blocked
    assert.ok(d2.blocked);

    // payment_send + verified → tool_sequence passes, agent_level fails → any_of = false → not blocked
    const d3 = engine.evaluate({
      agentId: "a",
      action: "tool_call",
      tool: "payment_send",
      agentLevel: 4,
      toolHistory: ["verify_identity"],
    });
    assert.ok(!d3.blocked);
  });
});

describe("requireSequence preset", () => {
  it("creates a proper policy rule", () => {
    const rule = requireSequence("deploy", ["test", "build"]);
    assert.equal(rule.condition.type, "tool_sequence");
    assert.equal(rule.outcome, "block");
    assert.equal(rule.enabled, true);
    assert.ok(rule.reason.includes("test"));
    assert.ok(rule.reason.includes("build"));
  });
});
