import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  blockTools,
  requireLevel,
  requireApproval,
  tokenBudget,
  rateLimit,
  allowOnlyTools,
  requireSequence,
  timeWindow,
} from "./index";

describe("governance integration", () => {
  test("full lifecycle: register → enforce → audit → score", async () => {
    const gov = createGovernance({
      rules: [blockTools(["rm_rf"])],
    });

    // Register
    const agent = await gov.register({
      name: "lifecycle-agent",
      framework: "mastra",
      owner: "test-team",
      tools: ["search", "write"],
      hasAuth: true,
      hasGuardrails: true,
    });
    assert.ok(agent.id);
    assert.ok(agent.score > 0);

    // Enforce — allowed
    const allowed = await gov.enforce({
      agentId: agent.id,
      agentName: "lifecycle-agent",
      agentLevel: agent.level,
      action: "tool_call",
      tool: "search",
    });
    assert.equal(allowed.blocked, false);

    // Enforce — blocked
    const blocked = await gov.enforce({
      agentId: agent.id,
      agentName: "lifecycle-agent",
      agentLevel: agent.level,
      action: "tool_call",
      tool: "rm_rf",
    });
    assert.equal(blocked.blocked, true);

    // Audit trail
    const events = await gov.audit.query({ agentId: agent.id });
    assert.ok(events.length >= 3); // register + 2 enforce

    // Re-score
    const assessment = await gov.score(agent.id);
    assert.ok(assessment);
    assert.ok(assessment.compositeScore > 0);
  });

  test("multiple agents with fleet scoring", async () => {
    const gov = createGovernance();

    await gov.register({ name: "a1", framework: "mastra", owner: "team-a", tools: ["x"], hasAuth: true, hasGuardrails: true, hasObservability: true, hasAuditLog: true });
    await gov.register({ name: "a2", framework: "langchain", owner: "team-b", tools: ["y"] });
    await gov.register({ name: "a3", framework: "custom", owner: "team-c" });

    const fleet = await gov.scoreFleet();
    assert.equal(fleet.assessments.length, 3);
    assert.equal(fleet.summary.totalAgents, 3);
    assert.ok(fleet.summary.averageScore > 0);
  });

  test("custom audit events are logged and queryable", async () => {
    const gov = createGovernance();
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await gov.audit.log({
      agentId: agent.id,
      eventType: "custom_event",
      outcome: "success",
      severity: "info",
      detail: { key: "value" },
    });

    const events = await gov.audit.query({ eventType: "custom_event" });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].detail, { key: "value" });
  });

  test("audit count works with filters", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await gov.enforce({ agentId: agent.id, agentName: "a", agentLevel: 0, action: "tool_call", tool: "danger" });
    await gov.enforce({ agentId: agent.id, agentName: "a", agentLevel: 0, action: "tool_call", tool: "safe" });

    const blocked = await gov.audit.count({ outcome: "blocked" });
    const allowed = await gov.audit.count({ outcome: "allowed" });
    assert.equal(blocked, 1);
    assert.equal(allowed, 1);
  });

  test("score returns null for unknown agent", async () => {
    const gov = createGovernance();
    assert.equal(await gov.score("nonexistent"), null);
  });

  test("policy engine is accessible via gov.policies", async () => {
    const gov = createGovernance({ rules: [blockTools(["x"])] });
    const rules = gov.policies.getRules();
    assert.ok(rules.length > 0);
  });

  test("storage is accessible via gov.storage", async () => {
    const gov = createGovernance();
    await gov.register({ name: "a", framework: "mastra", owner: "t" });
    const agents = await gov.storage.listAgents();
    assert.equal(agents.length, 1);
  });

  test("default outcome is allow when no rules match", async () => {
    const gov = createGovernance();
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });
    const decision = await gov.enforce({ agentId: agent.id, agentName: "a", agentLevel: 0, action: "tool_call", tool: "anything" });
    assert.equal(decision.blocked, false);
  });

  test("default outcome can be set to block", async () => {
    const gov = createGovernance({ defaultOutcome: "block" });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });
    const decision = await gov.enforce({ agentId: agent.id, agentName: "a", agentLevel: 0, action: "tool_call", tool: "anything" });
    assert.equal(decision.blocked, true);
  });

  test("requireApproval marks actions for review", async () => {
    const gov = createGovernance({ rules: [requireApproval(["payment"])] });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });
    const decision = await gov.enforce({ agentId: agent.id, agentName: "a", agentLevel: 0, action: "payment", tool: "stripe" });
    assert.equal(decision.outcome, "require_approval");
    assert.equal(decision.blocked, true);
  });

  test("multiple rules with priority ordering", async () => {
    const gov = createGovernance({
      rules: [
        blockTools(["shell_exec"]),
        requireApproval(["tool_call"]),
      ],
    });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    // blockTools has higher priority, should block
    const decision = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: 0,
      action: "tool_call", tool: "shell_exec",
    });
    assert.equal(decision.blocked, true);
  });

  test("requireLevel blocks low-level agents", async () => {
    const gov = createGovernance({ rules: [requireLevel(3)] });
    // minimal agent will have low governance level
    const agent = await gov.register({ name: "a", framework: "unknown", owner: "t" });
    const decision = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: agent.level,
      action: "tool_call", tool: "x",
    });
    assert.equal(decision.blocked, true);
  });

  test("tokenBudget blocks when exceeded", async () => {
    const gov = createGovernance({ rules: [tokenBudget(1000)] });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    const ok = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: 0,
      action: "tool_call", tool: "x", sessionTokensUsed: 500,
    });
    assert.equal(ok.blocked, false);

    const blocked = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: 0,
      action: "tool_call", tool: "x", sessionTokensUsed: 1500,
    });
    assert.equal(blocked.blocked, true);
  });

  test("rateLimit blocks excessive actions", async () => {
    const gov = createGovernance({ rules: [rateLimit(5, 60000)] });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    const blocked = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: 0,
      action: "tool_call", tool: "x", recentActionCount: 10,
    });
    assert.equal(blocked.blocked, true);
  });

  test("allowOnlyTools blocks unlisted tools", async () => {
    const gov = createGovernance({ rules: [allowOnlyTools(["search", "read"])] });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    const allowed = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: 0,
      action: "tool_call", tool: "search",
    });
    assert.equal(allowed.blocked, false);

    const blocked = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: 0,
      action: "tool_call", tool: "shell_exec",
    });
    assert.equal(blocked.blocked, true);
  });

  test("requireSequence blocks when prerequisite missing", async () => {
    const gov = createGovernance({ rules: [requireSequence("delete", ["backup"])] });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    const blocked = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: 0,
      action: "tool_call", tool: "delete", toolHistory: [],
    });
    assert.equal(blocked.blocked, true);

    const allowed = await gov.enforce({
      agentId: agent.id, agentName: "a", agentLevel: 0,
      action: "tool_call", tool: "delete", toolHistory: ["backup"],
    });
    assert.equal(allowed.blocked, false);
  });

  test("agent registration records audit event", async () => {
    const gov = createGovernance();
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    const events = await gov.audit.query({ agentId: agent.id, eventType: "agent_registered" });
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "success");
  });

  test("enforcement records audit event with policy details", async () => {
    const gov = createGovernance({ rules: [blockTools(["x"])] });
    const agent = await gov.register({ name: "a", framework: "mastra", owner: "t" });

    await gov.enforce({ agentId: agent.id, agentName: "a", agentLevel: 0, action: "tool_call", tool: "x" });

    const events = await gov.audit.query({ eventType: "policy_evaluation", outcome: "blocked" });
    assert.equal(events.length, 1);
    assert.ok(events[0].policyRuleId);
  });
});
