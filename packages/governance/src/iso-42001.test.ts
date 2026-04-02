import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireApproval, tokenBudget } from "./index";
import { assessIso42001, getIsoClauses } from "./iso-42001";

describe("ISO 42001", () => {
  it("exports 6 clauses", () => {
    const clauses = getIsoClauses();
    assert.equal(clauses.length, 6);
    assert.deepEqual(clauses.map((c) => c.id), ["4", "5", "6", "8", "9", "10"]);
  });

  it("each clause has requirements with unique IDs", () => {
    const ids = getIsoClauses().flatMap((c) => c.requirements.map((r) => r.id));
    assert.equal(ids.length, new Set(ids).size, "Duplicate requirement IDs");
    assert.ok(ids.length >= 10);
  });

  it("assesses well-configured governance as mostly compliant", async () => {
    const gov = createGovernance({
      rules: [
        blockTools(["shell_exec"]),
        requireApproval(["payment"]),
        tokenBudget(100_000),
      ],
    });

    const agent = await gov.register({
      name: "test-agent", framework: "mastra", owner: "team-a",
      description: "Test agent for ISO assessment",
      tools: ["search"], hasAuth: true, hasObservability: true,
    });
    await gov.enforce({ agentId: agent.id, action: "tool_call", tool: "shell_exec" });

    const stored = await gov.storage.getAgent(agent.id);
    const report = await assessIso42001({
      governance: gov, agents: stored ? [stored] : [],
    });

    assert.ok(report.overallScore > 50, `Expected score > 50, got ${report.overallScore}`);
    assert.equal(report.clauses.length, 6);
    assert.ok(report.generatedAt);
  });

  it("assesses empty governance as non-compliant", async () => {
    const gov = createGovernance();
    const report = await assessIso42001({ governance: gov, agents: [] });
    assert.equal(report.status, "non-compliant");
    assert.ok(report.criticalGaps.length > 0);
  });

  it("clause 10.1 kill switch is always compliant", async () => {
    const gov = createGovernance();
    const report = await assessIso42001({ governance: gov, agents: [] });
    const clause10 = report.clauses.find((c) => c.article === "10");
    assert.ok(clause10);
    const killReq = clause10.requirements.find((r) => r.requirementId === "iso-10.1");
    assert.ok(killReq);
    assert.equal(killReq.status, "compliant");
  });
});
