import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireApproval, tokenBudget } from "./index";
import { dryRun, fleetDryRun } from "./dry-run";
import type { DryRunAction } from "./dry-run";

// ─── Helpers ────────────────────────────────────────────────────

async function setupGov(rules = [blockTools(["shell_exec", "rm_rf"])]) {
  const gov = createGovernance({ rules });

  const agent1 = await gov.register({
    name: "agent-1",
    framework: "mastra",
    owner: "team-a",
    tools: ["search", "shell_exec"],
    hasAuth: true,
    hasGuardrails: true,
  });

  const agent2 = await gov.register({
    name: "agent-2",
    framework: "langchain",
    owner: "team-b",
    tools: ["read", "write"],
  });

  return { gov, agent1, agent2 };
}

const safeActions: DryRunAction[] = [
  { action: "tool_call", tool: "search" },
  { action: "tool_call", tool: "read" },
];

const mixedActions: DryRunAction[] = [
  { action: "tool_call", tool: "search" },
  { action: "tool_call", tool: "shell_exec" },
  { action: "tool_call", tool: "rm_rf" },
];

// ─── dryRun ─────────────────────────────────────────────────────

describe("dryRun", () => {
  test("simulates enforcement without modifying state", async () => {
    const { gov, agent1 } = await setupGov();
    const auditBefore = await gov.audit.count();

    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: mixedActions,
    });

    // No new audit events should be created
    const auditAfter = await gov.audit.count();
    assert.equal(auditAfter, auditBefore);
    assert.ok(result.decisions.length > 0);
  });

  test("returns correct block/allow counts", async () => {
    const { gov, agent1 } = await setupGov();

    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: mixedActions,
    });

    assert.equal(result.summary.totalActions, 3);
    assert.equal(result.summary.wouldBlock, 2); // shell_exec, rm_rf
    assert.equal(result.summary.wouldAllow, 1); // search
  });

  test("calculates block rate correctly", async () => {
    const { gov, agent1 } = await setupGov();

    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: mixedActions,
    });

    const expectedRate = 2 / 3;
    assert.ok(Math.abs(result.summary.blockRate - expectedRate) < 0.01);
  });

  test("all safe actions = 0 blocks", async () => {
    const { gov, agent1 } = await setupGov();

    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: safeActions,
    });

    assert.equal(result.summary.wouldBlock, 0);
    assert.equal(result.summary.wouldAllow, 2);
    assert.equal(result.summary.blockRate, 0);
  });

  test("resolves agent by name", async () => {
    const { gov } = await setupGov();

    const result = await dryRun(gov, {
      agentName: "agent-1",
      actions: safeActions,
    });

    assert.equal(result.agentName, "agent-1");
    assert.ok(result.agentId);
  });

  test("throws for unknown agent", async () => {
    const { gov } = await setupGov();

    await assert.rejects(
      () => dryRun(gov, {
        agentId: "nonexistent",
        actions: safeActions,
      }),
      { message: "Agent not found: nonexistent" },
    );
  });

  test("throws for unknown agent name", async () => {
    const { gov } = await setupGov();

    await assert.rejects(
      () => dryRun(gov, {
        agentName: "nope",
        actions: safeActions,
      }),
      { message: "Agent not found: nope" },
    );
  });

  test("returns agent metadata", async () => {
    const { gov, agent1 } = await setupGov();

    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: safeActions,
    });

    assert.equal(result.agentId, agent1.id);
    assert.equal(result.agentName, "agent-1");
    assert.ok(result.agentLevel >= 0);
  });

  test("tracks triggered rules", async () => {
    const { gov, agent1 } = await setupGov();

    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: mixedActions,
    });

    assert.ok(result.summary.rulesTriggered.length > 0);
  });

  test("each decision maps to its action", async () => {
    const { gov, agent1 } = await setupGov();

    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: mixedActions,
    });

    assert.equal(result.decisions.length, 3);
    assert.equal(result.decisions[0].action.tool, "search");
    assert.equal(result.decisions[1].action.tool, "shell_exec");
    assert.equal(result.decisions[2].action.tool, "rm_rf");
  });

  test("uses custom rules when provided", async () => {
    const { gov, agent1 } = await setupGov();

    // Default rules block shell_exec, but custom rules only block "search"
    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: mixedActions,
    }, {
      rules: [blockTools(["search"])],
    });

    assert.equal(result.summary.wouldBlock, 1); // only search
    assert.equal(result.summary.wouldAllow, 2); // shell_exec + rm_rf allowed under custom rules
  });

  test("handles require_approval outcome", async () => {
    const gov = createGovernance({
      rules: [requireApproval(["payment"])],
    });

    const agent = await gov.register({
      name: "payment-agent",
      framework: "mastra",
      owner: "finance",
    });

    const result = await dryRun(gov, {
      agentId: agent.id,
      actions: [
        { action: "payment", tool: "stripe_charge" },
        { action: "tool_call", tool: "search" },
      ],
    });

    assert.equal(result.summary.wouldRequireApproval, 1);
    assert.equal(result.summary.wouldAllow, 1);
    assert.equal(result.summary.wouldBlock, 0);
  });

  test("handles token budget in dry run", async () => {
    const gov = createGovernance({
      rules: [tokenBudget(50_000)],
    });

    const agent = await gov.register({
      name: "agent",
      framework: "mastra",
      owner: "team",
    });

    const result = await dryRun(gov, {
      agentId: agent.id,
      actions: [
        { action: "tool_call", tool: "search", sessionTokensUsed: 10_000 },
        { action: "tool_call", tool: "search", sessionTokensUsed: 60_000 },
      ],
    });

    assert.equal(result.summary.wouldBlock, 1);
    assert.equal(result.summary.wouldAllow, 1);
  });

  test("empty actions returns zero summary", async () => {
    const { gov, agent1 } = await setupGov();

    const result = await dryRun(gov, {
      agentId: agent1.id,
      actions: [],
    });

    assert.equal(result.summary.totalActions, 0);
    assert.equal(result.summary.blockRate, 0);
  });
});

// ─── fleetDryRun ────────────────────────────────────────────────

describe("fleetDryRun", () => {
  test("tests all agents against same actions", async () => {
    const { gov } = await setupGov();

    const result = await fleetDryRun(gov, mixedActions);

    assert.equal(result.fleetSummary.totalAgents, 2);
    assert.equal(result.results.length, 2);
    assert.equal(result.fleetSummary.totalActions, 6); // 3 actions × 2 agents
  });

  test("tracks agents affected by blocks", async () => {
    const { gov } = await setupGov();

    const result = await fleetDryRun(gov, mixedActions);

    assert.ok(result.fleetSummary.agentsAffected > 0);
  });

  test("aggregates fleet-wide block rate", async () => {
    const { gov } = await setupGov();

    const result = await fleetDryRun(gov, mixedActions);

    // 2 blocks per agent × 2 agents = 4 blocks out of 6 total
    assert.ok(result.fleetSummary.blockRate > 0);
    assert.ok(result.fleetSummary.totalBlocked > 0);
  });

  test("aggregates triggered rules across fleet", async () => {
    const { gov } = await setupGov();

    const result = await fleetDryRun(gov, mixedActions);

    assert.ok(result.fleetSummary.rulesTriggered.length > 0);
  });

  test("includes timestamp", async () => {
    const { gov } = await setupGov();

    const result = await fleetDryRun(gov, safeActions);
    assert.ok(result.testedAt);
    assert.ok(!isNaN(Date.parse(result.testedAt)));
  });

  test("empty fleet returns zero summary", async () => {
    const gov = createGovernance();

    const result = await fleetDryRun(gov, mixedActions);

    assert.equal(result.fleetSummary.totalAgents, 0);
    assert.equal(result.fleetSummary.totalActions, 0);
    assert.equal(result.fleetSummary.blockRate, 0);
    assert.equal(result.results.length, 0);
  });

  test("uses custom rules for fleet-wide testing", async () => {
    const { gov } = await setupGov();

    // Override with no blocking rules
    const result = await fleetDryRun(gov, mixedActions, {
      rules: [],
    });

    assert.equal(result.fleetSummary.totalBlocked, 0);
    assert.equal(result.fleetSummary.totalAllowed, 6);
  });
});
