import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  blockTools,
  allowOnlyTools,
  requireLevel,
  tokenBudget,
  rateLimit,
  requireApproval,
  requireSequence,
  assessAgent,
  assessFleet,
  createPolicyEngine,
} from "./index";

// ─── createGovernance config combinations ───────────────────────

describe("createGovernance config edge cases", () => {
  test("creates with empty config", () => {
    const gov = createGovernance({});
    assert.ok(gov.register);
    assert.ok(gov.enforce);
  });

  test("creates with no arguments", () => {
    const gov = createGovernance();
    assert.ok(gov.policies.ruleCount === 0);
  });

  test("creates with defaultOutcome block", async () => {
    const gov = createGovernance({ defaultOutcome: "block" });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });
    const decision = await gov.enforce({ agentId: agent.id, action: "tool_call" });
    assert.equal(decision.blocked, true);
    assert.equal(decision.reason, "No policy rules matched");
  });

  test("creates with multiple rule types combined", async () => {
    const gov = createGovernance({
      rules: [
        blockTools(["shell_exec"]),
        requireLevel(2),
        tokenBudget(100_000),
        rateLimit(50, 60_000),
      ],
    });
    assert.equal(gov.policies.ruleCount, 4);
  });

  test("creates with empty rules array", async () => {
    const gov = createGovernance({ rules: [] });
    assert.equal(gov.policies.ruleCount, 0);
  });
});

// ─── enforce edge cases ─────────────────────────────────────────

describe("enforce edge cases", () => {
  test("enforce with minimal context", async () => {
    const gov = createGovernance();
    const decision = await gov.enforce({ agentId: "test", action: "tool_call" });
    assert.equal(decision.blocked, false);
  });

  test("enforce with all context fields", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });
    const decision = await gov.enforce({
      agentId: "test",
      agentName: "test-agent",
      agentLevel: 3,
      action: "tool_call",
      tool: "safe_tool",
      input: { query: "hello" },
      metadata: { requestId: "r1" },
      sessionTokensUsed: 5000,
      recentActionCount: 10,
      toolHistory: ["web_search"],
    });
    assert.equal(decision.blocked, false);
  });

  test("enforce logs audit event for blocked action", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    await gov.enforce({ agentId: "a1", action: "tool_call", tool: "shell_exec" });
    const events = await gov.audit.query({ agentId: "a1", outcome: "blocked" });
    assert.ok(events.length >= 1);
  });

  test("enforce logs audit event for allowed action", async () => {
    const gov = createGovernance();
    await gov.enforce({ agentId: "a1", action: "tool_call", tool: "web_search" });
    const events = await gov.audit.query({ agentId: "a1", outcome: "allowed" });
    assert.ok(events.length >= 1);
  });

  test("enforce with tool not in blocked list passes", async () => {
    const gov = createGovernance({ rules: [blockTools(["a", "b", "c"])] });
    const decision = await gov.enforce({ agentId: "x", action: "tool_call", tool: "d" });
    assert.equal(decision.blocked, false);
  });

  test("enforce with allowOnlyTools blocks unlisted tools", async () => {
    const gov = createGovernance({ rules: [allowOnlyTools(["web_search", "email_read"])] });
    const blocked = await gov.enforce({ agentId: "x", action: "tool_call", tool: "shell_exec" });
    assert.equal(blocked.blocked, true);
    const allowed = await gov.enforce({ agentId: "x", action: "tool_call", tool: "web_search" });
    assert.equal(allowed.blocked, false);
  });

  test("enforce with requireSequence blocks missing prerequisite", async () => {
    const gov = createGovernance({ rules: [requireSequence("file_delete", ["file_backup"])] });
    const blocked = await gov.enforce({
      agentId: "x",
      action: "tool_call",
      tool: "file_delete",
      toolHistory: [],
    });
    assert.equal(blocked.blocked, true);

    const allowed = await gov.enforce({
      agentId: "x",
      action: "tool_call",
      tool: "file_delete",
      toolHistory: ["file_backup"],
    });
    assert.equal(allowed.blocked, false);
  });
});

// ─── register edge cases ────────────────────────────────────────

describe("register edge cases", () => {
  test("register with minimal fields", async () => {
    const gov = createGovernance();
    const result = await gov.register({ name: "a", framework: "custom", owner: "x" });
    assert.ok(result.id);
    assert.ok(typeof result.score === "number");
  });

  test("register with all fields populated", async () => {
    const gov = createGovernance();
    const result = await gov.register({
      name: "full-agent",
      framework: "mastra",
      owner: "team-a",
      description: "A fully configured agent for testing",
      version: "3.2.1",
      channels: ["slack", "email", "whatsapp"],
      tools: ["web_search", "crm_update", "email_send"],
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
      permissions: { canAccessPII: false, maxSpend: 1000 },
      metadata: { team: "sales", region: "us-west" },
    });
    assert.ok(result.score >= 80);
    assert.equal(result.level, 4);
  });

  test("register with special characters in name", async () => {
    const gov = createGovernance();
    const result = await gov.register({
      name: "agent-with-special chars @#$%",
      framework: "mastra",
      owner: "test",
    });
    assert.ok(result.id);
  });

  test("register with empty string name", async () => {
    const gov = createGovernance();
    const result = await gov.register({ name: "", framework: "mastra", owner: "" });
    assert.ok(result.id);
  });

  test("register with unicode name", async () => {
    const gov = createGovernance();
    const result = await gov.register({
      name: "エージェント-日本語",
      framework: "mastra",
      owner: "チーム",
    });
    assert.ok(result.id);
  });

  test("register creates audit event", async () => {
    const gov = createGovernance();
    const result = await gov.register({ name: "a", framework: "mastra", owner: "t" });
    const events = await gov.audit.query({ agentId: result.id, eventType: "agent_registered" });
    assert.equal(events.length, 1);
  });

  test("multiple registrations get unique IDs", async () => {
    const gov = createGovernance();
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await gov.register({ name: `agent-${i}`, framework: "mastra", owner: "t" });
      ids.add(r.id);
    }
    assert.equal(ids.size, 10);
  });
});

// ─── scoreFleet edge cases ──────────────────────────────────────

describe("scoreFleet edge cases", () => {
  test("scoreFleet with 0 agents", async () => {
    const gov = createGovernance();
    const fleet = await gov.scoreFleet();
    assert.equal(fleet.summary.totalAgents, 0);
    assert.equal(fleet.summary.averageScore, 0);
    assert.equal(fleet.summary.highestScoring, null);
    assert.equal(fleet.summary.lowestScoring, null);
  });

  test("scoreFleet with 1 agent", async () => {
    const gov = createGovernance();
    await gov.register({ name: "solo", framework: "mastra", owner: "t", hasAuth: true });
    const fleet = await gov.scoreFleet();
    assert.equal(fleet.summary.totalAgents, 1);
    assert.ok(fleet.summary.highestScoring);
    assert.equal(fleet.summary.highestScoring!.name, "solo");
  });

  test("scoreFleet with many agents", async () => {
    const gov = createGovernance();
    for (let i = 0; i < 20; i++) {
      await gov.register({
        name: `agent-${i}`,
        framework: i % 2 === 0 ? "mastra" : "langchain",
        owner: `team-${i % 3}`,
        hasAuth: i % 2 === 0,
      });
    }
    const fleet = await gov.scoreFleet();
    assert.equal(fleet.summary.totalAgents, 20);
    assert.ok(fleet.summary.averageScore > 0);
    assert.ok(fleet.summary.highestScoring!.score >= fleet.summary.lowestScoring!.score);
  });
});

// ─── assessAgent edge cases ─────────────────────────────────────

describe("assessAgent edge cases", () => {
  test("returns 7 dimensions always", () => {
    const assessment = assessAgent("x", { name: "a", framework: "unknown", owner: "t" });
    assert.equal(assessment.dimensions.length, 7);
  });

  test("all dimension scores are 0-100", () => {
    const assessment = assessAgent("x", {
      name: "test",
      framework: "mastra",
      owner: "team",
      hasAuth: true,
      hasGuardrails: true,
    });
    for (const d of assessment.dimensions) {
      assert.ok(d.score >= 0 && d.score <= 100, `${d.dimension} score ${d.score} out of range`);
    }
  });

  test("composite score is weighted average of dimensions", () => {
    const assessment = assessAgent("x", { name: "a", framework: "mastra", owner: "t" });
    assert.ok(assessment.compositeScore >= 0 && assessment.compositeScore <= 100);
  });

  test("recommendations are generated for low-scoring dimensions", () => {
    const assessment = assessAgent("x", { name: "a", framework: "unknown", owner: "t" });
    assert.ok(assessment.recommendations.length > 0);
  });

  test("no recommendations for fully configured agent", () => {
    const assessment = assessAgent("x", {
      name: "perfect",
      framework: "mastra",
      owner: "eng",
      description: "Full",
      version: "2.0.0",
      channels: ["slack"],
      tools: ["t1"],
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
      permissions: { read: true },
    });
    assert.ok(assessment.recommendations.some((r) => r.includes("meets all governance")));
  });
});

// ─── assessFleet edge cases ─────────────────────────────────────

describe("assessFleet edge cases", () => {
  test("empty fleet", () => {
    const result = assessFleet([]);
    assert.equal(result.summary.totalAgents, 0);
    assert.equal(result.summary.averageScore, 0);
    assert.equal(result.assessments.length, 0);
  });

  test("single agent fleet", () => {
    const result = assessFleet([{ id: "1", registration: { name: "a", framework: "mastra", owner: "t" } }]);
    assert.equal(result.summary.totalAgents, 1);
    assert.equal(result.assessments.length, 1);
  });

  test("fleet byFramework is populated", () => {
    const result = assessFleet([
      { id: "1", registration: { name: "a", framework: "mastra", owner: "t" } },
      { id: "2", registration: { name: "b", framework: "langchain", owner: "t" } },
      { id: "3", registration: { name: "c", framework: "mastra", owner: "t" } },
    ]);
    assert.equal(result.summary.byFramework.mastra, 2);
    assert.equal(result.summary.byFramework.langchain, 1);
  });
});

// ─── audit edge cases ───────────────────────────────────────────

describe("audit edge cases", () => {
  test("query with no matching filters returns empty", async () => {
    const gov = createGovernance();
    const events = await gov.audit.query({ agentId: "nonexistent" });
    assert.equal(events.length, 0);
  });

  test("count with no events returns 0", async () => {
    const gov = createGovernance();
    const count = await gov.audit.count();
    assert.equal(count, 0);
  });

  test("audit log returns complete event", async () => {
    const gov = createGovernance();
    const event = await gov.audit.log({
      agentId: "a1",
      eventType: "custom_event",
      outcome: "success",
      severity: "info",
      detail: { key: "value" },
    });
    assert.ok(event.id);
    assert.ok(event.createdAt);
    assert.equal(event.agentId, "a1");
    assert.equal(event.eventType, "custom_event");
  });

  test("query filters by severity", async () => {
    const gov = createGovernance();
    await gov.audit.log({ agentId: "a1", eventType: "e", outcome: "ok", severity: "critical" });
    await gov.audit.log({ agentId: "a1", eventType: "e", outcome: "ok", severity: "info" });
    const critical = await gov.audit.query({ severity: "critical" });
    assert.ok(critical.every((e) => e.severity === "critical"));
  });

  test("query with limit returns at most N events", async () => {
    const gov = createGovernance();
    for (let i = 0; i < 10; i++) {
      await gov.audit.log({ agentId: "a1", eventType: "e", outcome: "ok", severity: "info" });
    }
    const limited = await gov.audit.query({ limit: 3 });
    assert.equal(limited.length, 3);
  });
});

// ─── policy engine runtime mutations ────────────────────────────

describe("policy engine runtime mutations", () => {
  test("addRule replaces existing rule with same ID", () => {
    const engine = createPolicyEngine({ rules: [blockTools(["a"])] });
    const ruleId = engine.getRules()[0].id;
    engine.addRule({ ...engine.getRules()[0], reason: "Updated reason" });
    assert.equal(engine.ruleCount, 1);
    assert.equal(engine.getRules()[0].reason, "Updated reason");
  });

  test("removeRule with nonexistent ID is a no-op", () => {
    const engine = createPolicyEngine({ rules: [blockTools(["a"])] });
    engine.removeRule("nonexistent");
    assert.equal(engine.ruleCount, 1);
  });

  test("getRules returns copy not reference", () => {
    const engine = createPolicyEngine({ rules: [blockTools(["a"])] });
    const rules = engine.getRules();
    rules.pop();
    assert.equal(engine.ruleCount, 1);
  });

  test("disabled rules are not evaluated", () => {
    const engine = createPolicyEngine({
      rules: [{
        id: "disabled",
        name: "Disabled rule",
        condition: { type: "tool_blocked", tools: ["all"] },
        outcome: "block",
        reason: "Should not match",
        priority: 100,
        enabled: false,
      }],
    });
    const decision = engine.evaluate({ agentId: "x", action: "tool_call", tool: "all" });
    assert.equal(decision.blocked, false);
  });
});

// ─── score re-assessment ────────────────────────────────────────

describe("score re-assessment", () => {
  test("score returns null for nonexistent agent", async () => {
    const gov = createGovernance();
    const result = await gov.score("nonexistent-id");
    assert.equal(result, null);
  });

  test("score returns updated assessment for existing agent", async () => {
    const gov = createGovernance();
    const registered = await gov.register({ name: "a", framework: "mastra", owner: "t", hasAuth: true });
    const assessment = await gov.score(registered.id);
    assert.ok(assessment);
    assert.equal(assessment!.agentId, registered.id);
    assert.ok(assessment!.compositeScore > 0);
  });

  test("storage getAgentByName returns correct agent", async () => {
    const gov = createGovernance();
    await gov.register({ name: "unique-agent", framework: "mastra", owner: "team-x" });
    const found = await gov.storage.getAgentByName("unique-agent", "team-x");
    assert.ok(found);
    assert.equal(found!.name, "unique-agent");
  });

  test("storage getAgentByName returns null for unknown", async () => {
    const gov = createGovernance();
    const found = await gov.storage.getAgentByName("ghost", "nobody");
    assert.equal(found, null);
  });

  test("storage updateAgent throws for nonexistent agent", async () => {
    const gov = createGovernance();
    await assert.rejects(
      () => gov.storage.updateAgent("nonexistent", { status: "approved" }),
      { message: /not found/i },
    );
  });
});
