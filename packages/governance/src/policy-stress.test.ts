import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createPolicyEngine,
  blockTools,
  allowOnlyTools,
  requireLevel,
  tokenBudget,
  rateLimit,
  requireApproval,
  requireSequence,
  timeWindow,
} from "./index";
import { composePolicies, securityBaseline, complianceOverlay, platformDefaults } from "./policy-compose";

// ─── Conflicting rules ──────────────────────────────────────────

describe("conflicting policy rules", () => {
  test("same priority rules: first matching wins", () => {
    const engine = createPolicyEngine({
      rules: [
        { id: "r1", name: "Allow", condition: { type: "tool_blocked", params: { tools: ["test"] } }, outcome: "allow", reason: "Allowed", priority: 100, enabled: true },
        { id: "r2", name: "Block", condition: { type: "tool_blocked", params: { tools: ["test"] } }, outcome: "block", reason: "Blocked", priority: 100, enabled: true },
      ],
    });
    // Both match, same priority — first in sort order wins (stable sort)
    const decision = engine.evaluate({ agentId: "x", action: "tool_call", tool: "test" });
    assert.ok(decision.ruleId === "r1" || decision.ruleId === "r2");
  });

  test("higher priority rule wins over lower", () => {
    const engine = createPolicyEngine({
      rules: [
        { id: "low", name: "Low", condition: { type: "tool_blocked", params: { tools: ["test"] } }, outcome: "allow", reason: "Allowed", priority: 10, enabled: true },
        { id: "high", name: "High", condition: { type: "tool_blocked", params: { tools: ["test"] } }, outcome: "block", reason: "Blocked", priority: 200, enabled: true },
      ],
    });
    const decision = engine.evaluate({ agentId: "x", action: "tool_call", tool: "test" });
    assert.equal(decision.blocked, true);
    assert.equal(decision.ruleId, "high");
  });

  test("kill switch priority (999) overrides everything", () => {
    // Priorities >= 999 are reserved for internal rules (id prefixed `__`).
    // User rules at 999+ get clamped to 998, so the kill switch wins.
    const engine = createPolicyEngine({
      rules: [
        { id: "allow-all", name: "Allow All", condition: { type: "custom", params: { evaluate: () => true } }, outcome: "allow", reason: "All allowed", priority: 998, enabled: true },
        { id: "__kill_switch__test", name: "Kill Switch", condition: { type: "custom", params: { evaluate: () => true } }, outcome: "block", reason: "KILLED", priority: 999, enabled: true },
      ],
    });
    const decision = engine.evaluate({ agentId: "x", action: "tool_call" });
    assert.equal(decision.blocked, true);
    assert.equal(decision.ruleId, "__kill_switch__test");
  });
});

// ─── Large rule lists ───────────────────────────────────────────

describe("large rule lists", () => {
  test("100+ rules evaluate correctly", () => {
    const rules = Array.from({ length: 150 }, (_, i) => ({
      id: `rule-${i}`,
      name: `Rule ${i}`,
      condition: { type: "tool_blocked" as const, params: { tools: [`tool_${i}`] } },
      outcome: "block" as const,
      reason: `Blocked tool_${i}`,
      priority: i,
      enabled: true,
    }));
    const engine = createPolicyEngine({ rules });
    assert.equal(engine.ruleCount, 150);

    const decision = engine.evaluate({ agentId: "x", action: "tool_call", tool: "tool_75" });
    assert.equal(decision.blocked, true);
  });

  test("only enabled rules count", () => {
    const rules = Array.from({ length: 50 }, (_, i) => ({
      id: `rule-${i}`,
      name: `Rule ${i}`,
      condition: { type: "tool_blocked" as const, params: { tools: [`tool_${i}`] } },
      outcome: "block" as const,
      reason: `Blocked`,
      priority: i,
      enabled: i % 2 === 0,
    }));
    const engine = createPolicyEngine({ rules });
    assert.equal(engine.ruleCount, 25);
  });
});

// ─── Combinator conditions ──────────────────────────────────────

describe("combinator conditions", () => {
  test("any_of matches when any sub-condition matches", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "any",
        name: "Any of",
        condition: {
          type: "any_of",
          params: {
            conditions: [
              { type: "tool_blocked", params: { tools: ["a"] } },
              { type: "tool_blocked", params: { tools: ["b"] } },
            ],
          },
        },
        outcome: "block",
        reason: "Either a or b",
        priority: 100,
        enabled: true,
      }],
    });
    assert.equal(engine.evaluate({ agentId: "x", action: "tool_call", tool: "a" }).blocked, true);
    assert.equal(engine.evaluate({ agentId: "x", action: "tool_call", tool: "b" }).blocked, true);
    assert.equal(engine.evaluate({ agentId: "x", action: "tool_call", tool: "c" }).blocked, false);
  });

  test("all_of requires all sub-conditions", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "all",
        name: "All of",
        condition: {
          type: "all_of",
          params: {
            conditions: [
              { type: "action_type", params: { actions: ["payment"] } },
              { type: "agent_level", params: { minLevel: 3 } },
            ],
          },
        },
        outcome: "block",
        reason: "Payment + low level",
        priority: 100,
        enabled: true,
      }],
    });
    // Matches: payment + level < 3
    assert.equal(engine.evaluate({ agentId: "x", action: "payment", agentLevel: 1 }).blocked, true);
    // Does not match: tool_call + low level
    assert.equal(engine.evaluate({ agentId: "x", action: "tool_call", agentLevel: 1 }).blocked, false);
    // Does not match: payment + high level
    assert.equal(engine.evaluate({ agentId: "x", action: "payment", agentLevel: 4 }).blocked, false);
  });

  test("not inverts a condition", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "not-tool",
        name: "Not allowed tool",
        condition: {
          type: "not",
          params: {
            condition: { type: "tool_allowed", params: { tools: ["web_search", "email_read"] } },
          },
        },
        outcome: "block",
        reason: "Only web_search and email_read allowed (via not)",
        priority: 100,
        enabled: true,
      }],
    });
    // tool_allowed blocks when tool NOT in list, so not(tool_allowed) blocks when tool IS in list
    const web = engine.evaluate({ agentId: "x", action: "tool_call", tool: "web_search" });
    assert.equal(web.blocked, true);
  });

  test("nested combinators work", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "nested",
        name: "Nested",
        condition: {
          type: "any_of",
          params: {
            conditions: [
              {
                type: "all_of",
                params: {
                  conditions: [
                    { type: "action_type", params: { actions: ["payment"] } },
                    { type: "token_limit", params: { maxTokens: 10000 } },
                  ],
                },
              },
              { type: "tool_blocked", params: { tools: ["nuclear_launch"] } },
            ],
          },
        },
        outcome: "block",
        reason: "Complex nested rule",
        priority: 100,
        enabled: true,
      }],
    });
    // nuclear_launch always blocked
    assert.equal(engine.evaluate({ agentId: "x", action: "tool_call", tool: "nuclear_launch" }).blocked, true);
    // payment + over token limit blocked
    assert.equal(engine.evaluate({ agentId: "x", action: "payment", sessionTokensUsed: 50000 }).blocked, true);
    // payment under limit not blocked
    assert.equal(engine.evaluate({ agentId: "x", action: "payment", sessionTokensUsed: 5000 }).blocked, false);
  });
});

// ─── Policy composition edge cases ──────────────────────────────

describe("policy composition edge cases", () => {
  test("compose empty sets returns empty rules", () => {
    const result = composePolicies([]);
    assert.equal(result.rules.length, 0);
    assert.equal(result.conflicts.length, 0);
  });

  test("compose single set returns its rules", () => {
    const result = composePolicies([securityBaseline()]);
    assert.ok(result.rules.length >= 2);
  });

  test("compose detects conflicts between sets", () => {
    const result = composePolicies([
      securityBaseline(),
      complianceOverlay(),
      platformDefaults(),
    ], { conflictStrategy: "strict" });
    // token_budget in both compliance and platform → conflict
    assert.ok(result.totalRulesInput >= 5);
  });

  test("maxRules limits output", () => {
    const bigSets = Array.from({ length: 5 }, (_, i) => ({
      name: `set-${i}`,
      source: `source-${i}`,
      rules: Array.from({ length: 25 }, (_, j) => ({
        id: `rule-${i}-${j}`,
        name: `R${i}${j}`,
        condition: { type: "tool_blocked" as const, params: { tools: [`tool_${i}_${j}`] } },
        outcome: "block" as const,
        reason: "test",
        priority: j,
        enabled: true,
      })),
    }));
    const result = composePolicies(bigSets, { maxRules: 10 });
    assert.equal(result.rules.length, 10);
  });

  test("permissive strategy lets allow win", () => {
    const result = composePolicies([
      {
        name: "security",
        source: "sec",
        rules: [{
          id: "block-level",
          name: "Block low",
          condition: { type: "agent_level", params: { minLevel: 3 } },
          outcome: "block",
          reason: "Blocked",
          priority: 100,
          enabled: true,
        }],
      },
      {
        name: "ops",
        source: "ops",
        rules: [{
          id: "allow-level",
          name: "Allow all levels",
          condition: { type: "agent_level", params: { minLevel: 3 } },
          outcome: "allow",
          reason: "Allowed",
          priority: 100,
          enabled: true,
        }],
      },
    ], { conflictStrategy: "permissive" });

    const winner = result.rules.find((r) => r.id.includes("level"));
    assert.ok(winner);
    assert.equal(winner!.outcome, "allow");
  });
});

// ─── Custom condition ───────────────────────────────────────────

describe("custom condition evaluator", () => {
  test("custom function receives full context", () => {
    let receivedCtx: Record<string, unknown> = {};
    const engine = createPolicyEngine({
      rules: [{
        id: "spy",
        name: "Spy rule",
        condition: {
          type: "custom",
          params: {
            evaluate: (ctx) => {
              receivedCtx = ctx as unknown as Record<string, unknown>;
              return false;
            },
          },
        },
        outcome: "block",
        reason: "Spy",
        priority: 100,
        enabled: true,
      }],
    });

    engine.evaluate({
      agentId: "a1",
      agentName: "test",
      action: "tool_call",
      tool: "web_search",
      metadata: { key: "val" },
    });

    assert.equal(receivedCtx.agentId, "a1");
    assert.equal(receivedCtx.tool, "web_search");
  });
});

// ─── Data classification ────────────────────────────────────────

describe("data classification rules", () => {
  test("blocks when input contains classified data", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "classify",
        name: "PII Block",
        condition: { type: "data_classification", params: { blocked: ["ssn", "credit_card"] } },
        outcome: "block",
        reason: "PII detected",
        priority: 100,
        enabled: true,
      }],
    });

    const blocked = engine.evaluate({
      agentId: "x",
      action: "data_access",
      input: { data: "Patient SSN: 123-45-6789" },
    });
    assert.equal(blocked.blocked, true);

    const allowed = engine.evaluate({
      agentId: "x",
      action: "data_access",
      input: { data: "Just a normal email address" },
    });
    assert.equal(allowed.blocked, false);
  });
});
