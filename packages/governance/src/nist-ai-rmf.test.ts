import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireApproval, tokenBudget, rateLimit } from "./index";
import { assessNistAiRmf, getNistFunctions } from "./nist-ai-rmf";

describe("NIST AI RMF", () => {
  it("exports 4 functions", () => {
    const fns = getNistFunctions();
    assert.equal(fns.length, 4);
    assert.deepEqual(fns.map((f) => f.id), ["GOVERN", "MAP", "MEASURE", "MANAGE"]);
  });

  it("each function has requirements", () => {
    for (const fn of getNistFunctions()) {
      assert.ok(fn.requirements.length > 0, `${fn.id} has no requirements`);
    }
  });

  it("each requirement has a unique ID", () => {
    const ids = getNistFunctions().flatMap((f) => f.requirements.map((r) => r.id));
    assert.equal(ids.length, new Set(ids).size, "Duplicate requirement IDs");
  });

  it("assesses well-configured governance as mostly compliant", async () => {
    const gov = createGovernance({
      rules: [
        blockTools(["shell_exec"]),
        requireApproval(["payment"]),
        tokenBudget(100_000),
        rateLimit({ maxActions: 50, windowMs: 60_000 }),
      ],
    });

    const agent = await gov.register({
      name: "test-agent",
      framework: "mastra",
      owner: "platform-team",
      description: "Test agent for NIST assessment",
      tools: ["search", "email"],
      hasAuth: true,
      hasObservability: true,
      hasAuditLog: true,
    });

    await gov.enforce({ agentId: agent.id, agentName: "test-agent", agentLevel: agent.level, action: "tool_call", tool: "shell_exec" });

    const stored = await gov.storage.getAgent(agent.id);
    const report = await assessNistAiRmf({
      governance: gov,
      agents: stored ? [stored] : [],
    });

    assert.ok(report.overallScore > 50, `Expected score > 50, got ${report.overallScore}`);
    assert.equal(report.functions.length, 4);
    assert.ok(report.generatedAt);
  });

  it("assesses empty governance as non-compliant", async () => {
    const gov = createGovernance();
    const report = await assessNistAiRmf({ governance: gov, agents: [] });

    assert.equal(report.status, "non-compliant");
    assert.ok(report.criticalGaps.length > 0);
  });

  it("manage-4.1 kill switch is always compliant", async () => {
    const gov = createGovernance();
    const report = await assessNistAiRmf({ governance: gov, agents: [] });
    const manage = report.functions.find((f) => f.article === "MANAGE");
    assert.ok(manage);
    const killReq = manage.requirements.find((r) => r.requirementId === "manage-4.1");
    assert.ok(killReq);
    assert.equal(killReq.status, "compliant");
  });
});
