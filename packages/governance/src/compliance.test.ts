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
    // `daysUntilDeadline` is computed from the soonest upcoming per-article
    // deadline. If *all* deadlines are past, the number is negative — that's
    // honest and informative, so don't assert > 0.
    assert.equal(typeof report.daysUntilDeadline, "number");
  });

  it("surfaces a legal disclaimer and the phased enforcement schedule", async () => {
    const gov = createGovernance({});
    const report = await assessCompliance({ governance: gov, agents: [] });

    assert.ok(report.disclaimer, "disclaimer missing");
    assert.match(report.disclaimer!, /not legal advice/i);
    assert.match(report.disclaimer!, /Art 5-7|prohibited/i);
    assert.ok(report.phasedDeadlines);
    assert.equal(report.phasedDeadlines!.prohibitedPractices, "2025-02-02");
    assert.equal(report.phasedDeadlines!.gpaiTransparency, "2025-08-02");
    assert.equal(report.phasedDeadlines!.highRiskObligations, "2026-08-02");
    assert.equal(report.phasedDeadlines!.postMarketAndDownstream, "2027-08-02");
  });

  it("each article keeps its own deadline (not a single hardcoded date)", async () => {
    const gov = createGovernance({});
    const report = await assessCompliance({ governance: gov, agents: [] });
    const art50 = report.articles.find((a) => a.article === "50");
    const art9 = report.articles.find((a) => a.article === "9");
    assert.ok(art50 && art9);
    assert.equal(art50!.deadline, "2025-08-02");
    assert.equal(art9!.deadline, "2026-08-02");
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
