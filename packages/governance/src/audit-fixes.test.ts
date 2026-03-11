/**
 * Tests for architecture audit fixes — Part 1: Core security fixes.
 * Covers: storage resilience, async evaluator guard, SQL injection, encapsulation.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, createPolicyEngine, blockTools } from "./index";
import { createMemoryStorage } from "./storage";
import { getSchemaSQL } from "./storage-postgres-schema";

// ─── 1. Audit no longer blocks enforcement ───────────────────

describe("enforce() resilience to storage failures", () => {
  test("enforce returns decision even when storage throws", async () => {
    const failingStorage = {
      ...createMemoryStorage(),
      async createAuditEvent(): Promise<never> {
        throw new Error("Postgres is down");
      },
    };

    const gov = createGovernance({
      storage: failingStorage,
      rules: [blockTools(["shell_exec"])],
    });

    await gov.register({ name: "test-agent", framework: "custom", owner: "test" });

    const decision = await gov.enforce({
      agentId: "test", action: "tool_call", tool: "shell_exec",
    });

    assert.equal(decision.blocked, true);
    assert.equal(decision.ruleId !== null, true);
  });

  test("enforce returns allow decision even when storage throws", async () => {
    const failingStorage = {
      ...createMemoryStorage(),
      async createAuditEvent(): Promise<never> {
        throw new Error("Connection refused");
      },
    };

    const gov = createGovernance({
      storage: failingStorage,
      rules: [blockTools(["shell_exec"])],
    });

    const decision = await gov.enforce({
      agentId: "test", action: "tool_call", tool: "safe_tool",
    });

    assert.equal(decision.blocked, false);
  });
});

// ─── 2. Custom evaluator Promise detection ───────────────────

describe("custom evaluator Promise guard", () => {
  test("throws when custom evaluator returns a Promise", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "async-rule",
        name: "Bad async rule",
        condition: {
          type: "custom",
          evaluate: (() => Promise.resolve(true)) as unknown as (ctx: import("./policy").EnforcementContext) => boolean,
        },
        outcome: "block",
        reason: "Should never match",
        priority: 100,
        enabled: true,
      }],
    });

    assert.throws(
      () => engine.evaluate({ agentId: "a1", action: "tool_call" }),
      /Custom policy evaluator returned a Promise/,
    );
  });

  test("sync custom evaluator works normally", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "sync-rule",
        name: "Good sync rule",
        condition: {
          type: "custom",
          evaluate: (ctx) => ctx.agentId === "blocked-agent",
        },
        outcome: "block",
        reason: "Blocked by custom rule",
        priority: 100,
        enabled: true,
      }],
    });

    assert.equal(engine.evaluate({ agentId: "blocked-agent", action: "tool_call" }).blocked, true);
    assert.equal(engine.evaluate({ agentId: "other-agent", action: "tool_call" }).blocked, false);
  });
});

// ─── 3. SQL injection prevention ─────────────────────────────

describe("getSchemaSQL prefix sanitization", () => {
  test("rejects SQL injection in prefix", () => {
    assert.throws(() => getSchemaSQL("lua_gov; DROP TABLE users; --"), /Invalid table prefix/);
  });

  test("rejects prefix with special characters", () => {
    assert.throws(() => getSchemaSQL("prefix'OR'1'='1"), /Invalid table prefix/);
    assert.throws(() => getSchemaSQL("a b c"), /Invalid table prefix/);
    assert.throws(() => getSchemaSQL(""), /Invalid table prefix/);
    assert.throws(() => getSchemaSQL("123start"), /Invalid table prefix/);
  });

  test("accepts valid prefixes", () => {
    assert.doesNotThrow(() => getSchemaSQL("lua_gov"));
    assert.doesNotThrow(() => getSchemaSQL("my_prefix_123"));
    assert.doesNotThrow(() => getSchemaSQL("_private"));
    assert.doesNotThrow(() => getSchemaSQL("Gov"));
  });
});

// ─── 4. GovernanceInstance encapsulation ──────────────────────

describe("GovernanceInstance read-only policies", () => {
  test("policies object does not expose addRule/removeRule", () => {
    const gov = createGovernance({ rules: [blockTools(["rm"])] });

    assert.equal(typeof gov.policies.evaluate, "function");
    assert.equal(typeof gov.policies.getRules, "function");
    assert.equal(typeof gov.policies.ruleCount, "number");
    assert.equal("addRule" in gov.policies, false);
    assert.equal("removeRule" in gov.policies, false);
  });

  test("addRule/removeRule available on instance", () => {
    const gov = createGovernance();

    assert.equal(typeof gov.addRule, "function");
    assert.equal(typeof gov.removeRule, "function");

    gov.addRule(blockTools(["test_tool"]));
    assert.equal(gov.policies.ruleCount, 1);

    const rules = gov.policies.getRules();
    gov.removeRule(rules[0].id);
    assert.equal(gov.policies.ruleCount, 0);
  });
});

// ─── 5. Memory storage eviction ──────────────────────────────

describe("memory storage bounded growth", () => {
  test("evicts old events when exceeding 10,000", async () => {
    const storage = createMemoryStorage();

    for (let i = 0; i < 10_050; i++) {
      await storage.createAuditEvent({
        id: `evt-${i}`, agentId: "a1", eventType: "test",
        outcome: "success", severity: "info",
        createdAt: new Date(Date.now() + i).toISOString(),
      });
    }

    const count = await storage.countAuditEvents();
    assert.ok(count <= 10_000, `Expected <= 10000 events, got ${count}`);
  });
});
