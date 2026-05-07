import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  blockTools,
  requireApproval,
  tokenBudget,
  requireLevel,
  createPolicyEngine,
  assessAgent,
} from "./index";

describe("createGovernance", () => {
  test("register scores agent and returns assessment", async () => {
    const gov = createGovernance();
    const result = await gov.register({
      name: "test-agent",
      framework: "mastra",
      owner: "test-team",
      tools: ["web_search"],
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
    });

    assert.ok(result.id, "should return an id");
    assert.ok(result.score > 0, "should have a score");
    assert.ok(result.level >= 0 && result.level <= 4, "should have a level 0-4");
    assert.ok(result.assessment, "should include assessment");
    assert.equal(result.assessment.dimensions.length, 7, "should have 7 dimensions");
  });

  test("enforce blocks dangerous tools", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec", "rm_rf"])],
    });

    const agent = await gov.register({
      name: "safe-agent",
      framework: "mastra",
      owner: "team",
    });

    const allowed = await gov.enforce({
      agentId: agent.id,
      agentLevel: agent.level,
      action: "tool_call",
      tool: "web_search",
    });
    assert.equal(allowed.blocked, false, "web_search should be allowed");

    const blocked = await gov.enforce({
      agentId: agent.id,
      agentLevel: agent.level,
      action: "tool_call",
      tool: "shell_exec",
    });
    assert.equal(blocked.blocked, true, "shell_exec should be blocked");
    assert.ok(blocked.reason.includes("blocked"), "should explain why");
  });

  test("enforce respects governance levels", async () => {
    const gov = createGovernance({
      rules: [requireLevel(3)],
    });

    // Low-level agent (no auth, no guardrails)
    const lowAgent = await gov.register({
      name: "basic-bot",
      framework: "unknown",
      owner: "team",
    });

    const decision = await gov.enforce({
      agentId: lowAgent.id,
      agentLevel: lowAgent.level,
      action: "tool_call",
      tool: "anything",
    });
    assert.equal(decision.blocked, true, "low-level agent should be blocked");
  });

  test("enforce handles token budget", async () => {
    const gov = createGovernance({
      rules: [tokenBudget(50_000)],
    });

    const agent = await gov.register({
      name: "token-agent",
      framework: "mastra",
      owner: "team",
    });

    const underBudget = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      sessionTokensUsed: 30_000,
    });
    assert.equal(underBudget.blocked, false, "under budget should pass");

    const overBudget = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      sessionTokensUsed: 60_000,
    });
    assert.equal(overBudget.blocked, true, "over budget should be blocked");
  });

  test("enforce handles require_approval", async () => {
    const gov = createGovernance({
      rules: [requireApproval(["payment", "external_request"])],
    });

    const agent = await gov.register({
      name: "payment-agent",
      framework: "mastra",
      owner: "finance",
    });

    const decision = await gov.enforce({
      agentId: agent.id,
      action: "payment",
    });
    assert.equal(decision.outcome, "require_approval");
    assert.equal(decision.blocked, true, "require_approval gates the action");
  });

  test("audit trail logs events", async () => {
    const gov = createGovernance();

    const agent = await gov.register({
      name: "audit-agent",
      framework: "mastra",
      owner: "team",
    });

    await gov.audit.log({
      agentId: agent.id,
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
      detail: { tool: "web_search", query: "test" },
    });

    const count = await gov.audit.count();
    assert.ok(count >= 2, "should have registration + manual event");

    const events = await gov.audit.query({ agentId: agent.id });
    assert.ok(events.length >= 2, "should find events for agent");
  });

  test("scoreFleet returns fleet summary", async () => {
    const gov = createGovernance();

    await gov.register({
      name: "agent-1",
      framework: "mastra",
      owner: "team-a",
      hasAuth: true,
      hasGuardrails: true,
    });

    await gov.register({
      name: "agent-2",
      framework: "unknown",
      owner: "team-b",
    });

    const fleet = await gov.scoreFleet();
    assert.equal(fleet.summary.totalAgents, 2, "should have 2 agents");
    assert.ok(fleet.summary.averageScore > 0, "should have average score");
    assert.ok(fleet.summary.highestScoring, "should identify highest scoring");
    assert.ok(fleet.summary.lowestScoring, "should identify lowest scoring");
  });
});

describe("createGovernance — custom conditions", () => {
  test("registerCondition + addRule lets enforce() match a custom condition", async () => {
    const gov = createGovernance();
    gov.registerCondition({
      name: "geo_fence",
      description: "Block actions outside allowed regions",
      evaluator: (ctx, params) => {
        const region = (ctx.metadata?.region as string | undefined) ?? "";
        const allowed = params.allowedRegions as string[];
        return region.length > 0 && !allowed.includes(region);
      },
    });

    gov.addRule({
      id: "geo-rule",
      name: "Geo fence",
      condition: { type: "geo_fence", params: { allowedRegions: ["us", "eu"] } },
      outcome: "block",
      reason: "Region not allowed",
      priority: 100,
      enabled: true,
    });

    const blocked = await gov.enforce({
      agentId: "a1",
      action: "tool_call",
      tool: "any",
      metadata: { region: "cn" },
    });
    assert.equal(blocked.blocked, true, "non-allowed region should be blocked");
    assert.equal(blocked.ruleId, "geo-rule");

    const allowed = await gov.enforce({
      agentId: "a1",
      action: "tool_call",
      tool: "any",
      metadata: { region: "us" },
    });
    assert.equal(allowed.blocked, false, "allowed region should pass");
  });

  test("config.conditions registers conditions at construction time", async () => {
    const gov = createGovernance({
      conditions: [
        {
          name: "high_cost",
          description: "Block when session cost exceeds threshold",
          evaluator: (ctx, params) => (ctx.sessionCost ?? 0) > (params.maxCost as number),
        },
      ],
      rules: [
        {
          id: "cost-check",
          name: "Cost check",
          condition: { type: "high_cost", params: { maxCost: 10 } },
          outcome: "block",
          reason: "Session cost over budget",
          priority: 100,
          enabled: true,
        },
      ],
    });

    assert.ok(gov.getRegisteredCondition("high_cost"), "config.conditions should be registered");

    const blocked = await gov.enforce({
      agentId: "a1",
      action: "tool_call",
      sessionCost: 15,
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.ruleId, "cost-check");

    const allowed = await gov.enforce({
      agentId: "a1",
      action: "tool_call",
      sessionCost: 5,
    });
    assert.equal(allowed.blocked, false);
  });

  test("unregisterCondition + clearConditionRegistry forward to engine", () => {
    const gov = createGovernance();
    gov.registerCondition({ name: "tmp", description: "tmp", evaluator: () => false });
    assert.ok(gov.getRegisteredCondition("tmp"));
    assert.equal(gov.unregisterCondition("tmp"), true);
    assert.equal(gov.getRegisteredCondition("tmp"), undefined);

    gov.registerCondition({ name: "x", description: "x", evaluator: () => false });
    gov.clearConditionRegistry({ keepBuiltins: true });
    assert.equal(gov.getRegisteredCondition("x"), undefined);
    assert.ok(gov.getRegisteredCondition("tool_blocked"), "builtins kept");
  });
});

describe("createPolicyEngine", () => {
  test("evaluates rules in priority order", () => {
    const engine = createPolicyEngine({
      rules: [
        blockTools(["dangerous_tool"]),
        requireLevel(2),
      ],
    });

    // blockTools has priority 100, requireLevel has priority 95
    // blockTools should match first
    const decision = engine.evaluate({
      agentId: "test",
      agentLevel: 0,
      action: "tool_call",
      tool: "dangerous_tool",
    });

    assert.equal(decision.blocked, true);
    assert.ok(decision.ruleId?.includes("block-tools"));
  });

  test("addRule and removeRule work at runtime", () => {
    const engine = createPolicyEngine();
    assert.equal(engine.ruleCount, 0);

    engine.addRule(blockTools(["test_tool"]));
    assert.equal(engine.ruleCount, 1);

    engine.removeRule("block-tools-test_tool");
    assert.equal(engine.ruleCount, 0);
  });

  test("default outcome is allow when no rules match", () => {
    const engine = createPolicyEngine();
    const decision = engine.evaluate({
      agentId: "test",
      action: "tool_call",
    });
    assert.equal(decision.blocked, false);
    assert.equal(decision.outcome, "allow");
  });
});

describe("assessAgent", () => {
  test("well-configured agent scores high", () => {
    const assessment = assessAgent("test-id", {
      name: "production-agent",
      framework: "mastra",
      owner: "engineering",
      description: "Production-ready agent with full governance",
      version: "2.0.0",
      channels: ["slack", "email"],
      tools: ["web_search", "crm_update"],
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
      permissions: { canAccessPII: false },
    });

    assert.ok(assessment.compositeScore >= 80, `expected >= 80, got ${assessment.compositeScore}`);
    assert.equal(assessment.level.level, 4, "should be Level 4");
    assert.equal(assessment.status, "approved");
  });

  test("minimal agent scores low", () => {
    const assessment = assessAgent("test-id", {
      name: "basic-bot",
      framework: "unknown",
      owner: "unknown",
    });

    assert.ok(assessment.compositeScore < 40, `expected < 40, got ${assessment.compositeScore}`);
    assert.ok(assessment.level.level <= 1, "should be Level 0 or 1");
    assert.equal(assessment.status, "flagged");
  });
});
