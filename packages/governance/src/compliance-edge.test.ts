import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireApproval, tokenBudget, rateLimit } from "./index";
import { assessCompliance } from "./compliance";
import { getArticles, getDaysUntilDeadline } from "./compliance-articles";

describe("compliance assessment edge cases", () => {
  test("empty fleet with no rules = low score", async () => {
    const gov = createGovernance();
    const report = await assessCompliance({ governance: gov, agents: [] });
    assert.ok(report.overallScore < 50);
    assert.equal(report.agentsAssessed, 0);
    assert.ok(report.criticalGaps.length > 0);
  });

  test("full config with all flags = high score", async () => {
    const gov = createGovernance({
      rules: [blockTools(["x"]), requireApproval(["payment"]), tokenBudget(100000), rateLimit(10, 60000)],
    });
    const agent = await gov.register({
      name: "full-agent", framework: "mastra", owner: "team",
      description: "Full agent", tools: ["search", "read"],
      hasAuth: true, hasGuardrails: true, hasObservability: true, hasAuditLog: true,
      metadata: { hasAuth: true },
    });

    // Generate some audit events
    await gov.enforce({ agentId: agent.id, agentName: "full-agent", agentLevel: agent.level, action: "tool_call", tool: "x" });

    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({
      governance: gov, agents,
      auditIntegrity: true, humanOversight: true,
      logRetention: true, configVersionControlled: true, policiesTested: true,
    });

    assert.ok(report.overallScore >= 80);
    assert.equal(report.status, "compliant");
    assert.equal(report.criticalGaps.length, 0);
  });

  test("partial compliance returns partial status", async () => {
    const gov = createGovernance({ rules: [blockTools(["x"])] });
    const agent = await gov.register({
      name: "partial", framework: "mastra", owner: "team",
      tools: ["search"], hasAuth: true,
    });
    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({ governance: gov, agents });
    assert.equal(report.status, "partial");
  });

  test("recommendations are deduplicated", async () => {
    const gov = createGovernance();
    await gov.register({ name: "a1", framework: "unknown", owner: "t" });
    await gov.register({ name: "a2", framework: "unknown", owner: "t" });
    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({ governance: gov, agents });

    // Check for duplicates
    const unique = new Set(report.recommendations);
    assert.equal(report.recommendations.length, unique.size);
  });

  test("daysUntilDeadline is a positive number before deadline", () => {
    const days = getDaysUntilDeadline();
    // Deadline is 2026-08-02, test should work until then
    if (new Date() < new Date("2026-08-02")) {
      assert.ok(days > 0);
    }
  });

  test("getArticles returns 6 articles", () => {
    const articles = getArticles();
    assert.equal(articles.length, 6);
  });

  test("all articles have requirements", () => {
    const articles = getArticles();
    for (const a of articles) {
      assert.ok(a.requirements.length > 0, `Article ${a.article} has no requirements`);
    }
  });

  test("all requirements have unique IDs", () => {
    const articles = getArticles();
    const ids = new Set<string>();
    for (const a of articles) {
      for (const r of a.requirements) {
        assert.ok(!ids.has(r.id), `Duplicate requirement ID: ${r.id}`);
        ids.add(r.id);
      }
    }
  });

  test("report includes generatedAt timestamp", async () => {
    const gov = createGovernance();
    const report = await assessCompliance({ governance: gov, agents: [] });
    assert.ok(report.generatedAt);
    assert.ok(!isNaN(Date.parse(report.generatedAt)));
  });

  test("article assessments include deadlines and fines", async () => {
    const gov = createGovernance();
    const report = await assessCompliance({ governance: gov, agents: [] });
    for (const a of report.articles) {
      assert.ok(a.deadline);
      assert.ok(a.maxFine);
    }
  });

  test("score boundaries: 0 agents no rules = non-compliant on some articles", async () => {
    const gov = createGovernance();
    const report = await assessCompliance({ governance: gov, agents: [] });
    const nonCompliant = report.articles.filter((a) => a.coverage === "non-compliant");
    assert.ok(nonCompliant.length > 0);
  });

  test("agents without description are flagged for Art.11", async () => {
    const gov = createGovernance();
    await gov.register({ name: "no-desc", framework: "mastra", owner: "team" });
    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({ governance: gov, agents });

    const art11 = report.articles.find((a) => a.article === "11");
    assert.ok(art11);
    const sysDesc = art11.requirements.find((r) => r.requirementId === "art11-system-description");
    assert.ok(sysDesc);
    assert.notEqual(sysDesc.status, "compliant");
  });

  test("agents with tools documented = compliant for Art.11 capabilities", async () => {
    const gov = createGovernance();
    await gov.register({
      name: "documented", framework: "mastra", owner: "team",
      description: "Well documented", tools: ["search", "read"],
    });
    const agents = await gov.storage.listAgents();
    const report = await assessCompliance({ governance: gov, agents });

    const art11 = report.articles.find((a) => a.article === "11");
    const caps = art11!.requirements.find((r) => r.requirementId === "art11-capabilities");
    assert.equal(caps!.status, "compliant");
  });

  test("auditIntegrity flag affects Art.12 and Art.15", async () => {
    const gov = createGovernance();
    await gov.register({ name: "a", framework: "mastra", owner: "t" });
    const agents = await gov.storage.listAgents();

    const without = await assessCompliance({ governance: gov, agents });
    const with_ = await assessCompliance({ governance: gov, agents, auditIntegrity: true });

    assert.ok(with_.overallScore >= without.overallScore);
  });
});
