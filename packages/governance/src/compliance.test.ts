import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireApproval, tokenBudget } from "./index";
import { assessCompliance, getArticles, getDaysUntilDeadline } from "./compliance";

describe("EU AI Act Compliance (Articles 9, 11, 12, 14, 15)", () => {
  it("returns low score when governance is unconfigured", async () => {
    const gov = createGovernance({});
    const report = await assessCompliance({
      governance: gov,
      agents: [],
    });

    assert.ok(report.overallScore < 50);
    assert.equal(report.status, "non-compliant");
    assert.ok(report.criticalGaps.length > 0);
    assert.ok(report.recommendations.length > 0);
    assert.equal(report.articles.length, 6);
    assert.ok(report.daysUntilDeadline > 0);
  });

  it("scores higher with policies and registered agents", async () => {
    const gov = createGovernance({
      rules: [
        blockTools(["shell_exec", "database_drop"]),
        requireApproval(["payment"]),
        tokenBudget(100000),
      ],
    });

    // Register an agent
    const agent = await gov.register({
      name: "sales-agent",
      framework: "mastra",
      owner: "sales-team",
      description: "Handles customer outreach",
      tools: ["email_draft", "crm_update"],
      hasAuth: true,
      hasGuardrails: true,
    });

    // Trigger some enforcement
    await gov.enforce({
      agentId: agent.id,
      agentName: "sales-agent",
      agentLevel: agent.level,
      action: "tool_call",
      tool: "shell_exec",
    });

    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({
      governance: gov,
      agents,
      auditIntegrity: true,
      humanOversight: true,
      policiesTested: true,
      configVersionControlled: true,
      logRetention: true,
    });

    assert.ok(report.overallScore >= 80, `Expected >= 80, got ${report.overallScore}`);
    assert.equal(report.status, "compliant");
    assert.equal(report.agentsAssessed, 1);
  });

  it("identifies specific gaps for Article 12 (record-keeping)", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({
      governance: gov,
      agents,
      auditIntegrity: false, // Not using tamper-evident logs
    });

    const art12 = report.articles.find((a) => a.article === "12");
    assert.ok(art12);

    // Should flag missing audit integrity
    const integrityReq = art12.requirements.find((r) => r.requirementId === "art12-integrity");
    assert.ok(integrityReq);
    assert.equal(integrityReq.status, "non-compliant");
    assert.ok(integrityReq.remediation?.includes("createIntegrityAudit"));
  });

  it("identifies missing human oversight (Article 14)", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])], // No requireApproval
    });

    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({
      governance: gov,
      agents,
    });

    const art14 = report.articles.find((a) => a.article === "14");
    assert.ok(art14);

    const interventionReq = art14.requirements.find((r) => r.requirementId === "art14-intervention");
    assert.ok(interventionReq);
    assert.equal(interventionReq.status, "non-compliant");
  });

  it("recognizes requireApproval as human oversight", async () => {
    const gov = createGovernance({
      rules: [requireApproval(["payment", "data_access"])],
    });

    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({
      governance: gov,
      agents,
    });

    const art14 = report.articles.find((a) => a.article === "14");
    assert.ok(art14);

    const interventionReq = art14.requirements.find((r) => r.requirementId === "art14-intervention");
    assert.ok(interventionReq);
    assert.equal(interventionReq.status, "compliant");
  });

  it("getArticles returns 6 EU AI Act articles", () => {
    const articles = getArticles();
    assert.equal(articles.length, 6);
    assert.deepEqual(
      articles.map((a) => a.article),
      ["9", "11", "12", "14", "15", "50"],
    );
  });

  it("getDaysUntilDeadline returns positive number", () => {
    const days = getDaysUntilDeadline();
    assert.ok(days > 0);
    assert.ok(days < 600); // Sanity check
  });
});
