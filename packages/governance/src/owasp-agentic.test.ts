import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireApproval, tokenBudget, rateLimit } from "./index";
import { assessOwaspAgentic, getOwaspRisks } from "./owasp-agentic";

describe("OWASP Agentic Top 10", () => {
  it("exports 10 risks", () => {
    const risks = getOwaspRisks();
    assert.equal(risks.length, 10);
    assert.equal(risks[0].id, "OWASP-AA-01");
    assert.equal(risks[9].id, "OWASP-AA-10");
  });

  it("each risk has at least one requirement", () => {
    for (const risk of getOwaspRisks()) {
      assert.ok(risk.requirements.length > 0, `${risk.id} has no requirements`);
    }
  });

  it("each requirement has a unique ID", () => {
    const ids = getOwaspRisks().flatMap((r) => r.requirements.map((req) => req.id));
    assert.equal(ids.length, new Set(ids).size, "Duplicate requirement IDs found");
  });

  it("assesses a well-configured governance instance as mostly compliant", async () => {
    const gov = createGovernance({
      rules: [
        blockTools(["shell_exec", "eval"]),
        requireApproval(["payment"]),
        tokenBudget(100_000),
        rateLimit({ maxActions: 100, windowMs: 60_000 }),
      ],
    });

    const agent = await gov.register({
      name: "test-agent",
      framework: "mastra",
      owner: "team-a",
      tools: ["web_search", "crm_update"],
      hasAuth: true,
      hasGuardrails: true,
      hasObservability: true,
      hasAuditLog: true,
    });

    // Trigger some enforcement
    await gov.enforce({ agentId: agent.id, agentName: "test-agent", agentLevel: agent.level, action: "tool_call", tool: "shell_exec" });

    const stored = await gov.storage.getAgent(agent.id);
    const report = await assessOwaspAgentic({
      governance: gov,
      agents: stored ? [stored] : [],
      auditIntegrity: true,
      injectionDetection: true,
    });

    assert.ok(report.overallScore > 50, `Expected score > 50, got ${report.overallScore}`);
    assert.equal(report.risksTotal, 10);
    assert.ok(report.risksCovered > 0);
    assert.ok(report.generatedAt);
  });

  it("assesses empty governance as non-compliant", async () => {
    const gov = createGovernance();
    const report = await assessOwaspAgentic({ governance: gov, agents: [] });

    assert.equal(report.status, "non-compliant");
    assert.ok(report.criticalGaps.length > 0);
    assert.ok(report.recommendations.length > 0);
  });

  it("kill switch is always available (AA-10)", async () => {
    const gov = createGovernance();
    const report = await assessOwaspAgentic({ governance: gov, agents: [] });
    const aa10 = report.risks.find((r) => r.article === "OWASP-AA-10");
    assert.ok(aa10);
    const killReq = aa10.requirements.find((r) => r.requirementId === "aa10-kill-switch");
    assert.ok(killReq);
    assert.equal(killReq.status, "compliant");
  });
});
