import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assessAgent, assessFleet, getGovernanceLevel } from "./scorer";
import type { AgentRegistration } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function minimalAgent(overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  return {
    name: "test",
    framework: "unknown",
    owner: "team",
    ...overrides,
  };
}

function fullAgent(overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  return {
    name: "full-agent",
    framework: "mastra",
    owner: "platform-team",
    description: "A well-configured agent",
    version: "2.0.0",
    channels: ["slack", "api"],
    tools: ["search", "write"],
    hasAuth: true,
    hasGuardrails: true,
    hasObservability: true,
    hasAuditLog: true,
    permissions: { read: true, write: true },
    metadata: { environment: "production" },
    ...overrides,
  };
}

// ─── getGovernanceLevel ─────────────────────────────────────────

describe("getGovernanceLevel", () => {
  test("returns Level 0 for score 0", () => {
    assert.equal(getGovernanceLevel(0).level, 0);
  });

  test("returns Level 0 for score 20", () => {
    assert.equal(getGovernanceLevel(20).level, 0);
  });

  test("returns Level 1 for score 21", () => {
    assert.equal(getGovernanceLevel(21).level, 1);
  });

  test("returns Level 1 for score 40", () => {
    assert.equal(getGovernanceLevel(40).level, 1);
  });

  test("returns Level 2 for score 41", () => {
    assert.equal(getGovernanceLevel(41).level, 2);
  });

  test("returns Level 2 for score 60", () => {
    assert.equal(getGovernanceLevel(60).level, 2);
  });

  test("returns Level 3 for score 61", () => {
    assert.equal(getGovernanceLevel(61).level, 3);
  });

  test("returns Level 4 for score 81", () => {
    assert.equal(getGovernanceLevel(81).level, 4);
  });

  test("returns Level 4 for score 100", () => {
    assert.equal(getGovernanceLevel(100).level, 4);
  });

  test("clamps negative scores to Level 0", () => {
    assert.equal(getGovernanceLevel(-10).level, 0);
  });

  test("clamps scores above 100 to Level 4", () => {
    assert.equal(getGovernanceLevel(150).level, 4);
  });

  test("rounds fractional scores (59.5 → 60 = L2)", () => {
    assert.equal(getGovernanceLevel(59.5).level, 2);
  });

  test("rounds fractional scores (59.4 → 59 = L2)", () => {
    assert.equal(getGovernanceLevel(59.4).level, 2);
  });

  test("rounds fractional scores (20.5 → 21 = L1)", () => {
    assert.equal(getGovernanceLevel(20.5).level, 1);
  });

  test("level objects have correct labels", () => {
    assert.equal(getGovernanceLevel(0).label, "Unregistered");
    assert.equal(getGovernanceLevel(30).label, "Basic");
    assert.equal(getGovernanceLevel(50).label, "Managed");
    assert.equal(getGovernanceLevel(70).label, "Governed");
    assert.equal(getGovernanceLevel(90).label, "Certified");
  });
});

// ─── Dimension Scoring ──────────────────────────────────────────

describe("assessAgent dimension scoring", () => {
  test("identity: minimal agent gets name + owner points", () => {
    const result = assessAgent("a1", minimalAgent());
    const identity = result.dimensions.find((d) => d.dimension === "identity");
    assert.ok(identity);
    assert.ok(identity.score >= 15); // name
    assert.equal(identity.weight, 1.5);
  });

  test("identity: unknown framework scores lower", () => {
    const unknown = assessAgent("a1", minimalAgent({ framework: "unknown" }));
    const known = assessAgent("a2", minimalAgent({ framework: "langchain" }));
    const id1 = unknown.dimensions.find((d) => d.dimension === "identity")!;
    const id2 = known.dimensions.find((d) => d.dimension === "identity")!;
    assert.ok(id2.score > id1.score);
  });

  test("identity: version 1.0.0 is default, no bonus", () => {
    const defaultVer = assessAgent("a1", minimalAgent({ version: "1.0.0" }));
    const customVer = assessAgent("a2", minimalAgent({ version: "2.1.0" }));
    const id1 = defaultVer.dimensions.find((d) => d.dimension === "identity")!;
    const id2 = customVer.dimensions.find((d) => d.dimension === "identity")!;
    assert.ok(id2.score > id1.score);
  });

  test("permissions: many tools without permissions is penalized", () => {
    const manyTools = assessAgent("a1", minimalAgent({
      tools: Array.from({ length: 25 }, (_, i) => `tool_${i}`),
    }));
    const manyToolsWithPerms = assessAgent("a2", minimalAgent({
      tools: Array.from({ length: 25 }, (_, i) => `tool_${i}`),
      permissions: { admin: true },
    }));
    const p1 = manyTools.dimensions.find((d) => d.dimension === "permissions")!;
    const p2 = manyToolsWithPerms.dimensions.find((d) => d.dimension === "permissions")!;
    assert.ok(p2.score > p1.score);
  });

  test("permissions: fewer tools scores better", () => {
    const few = assessAgent("a1", minimalAgent({ tools: ["a", "b", "c"] }));
    const many = assessAgent("a2", minimalAgent({
      tools: Array.from({ length: 20 }, (_, i) => `tool_${i}`),
    }));
    const p1 = few.dimensions.find((d) => d.dimension === "permissions")!;
    const p2 = many.dimensions.find((d) => d.dimension === "permissions")!;
    assert.ok(p1.score >= p2.score);
  });

  test("permissions: score never goes below 0", () => {
    const agent = assessAgent("a1", minimalAgent({
      tools: Array.from({ length: 30 }, (_, i) => `tool_${i}`),
    }));
    const p = agent.dimensions.find((d) => d.dimension === "permissions")!;
    assert.ok(p.score >= 0);
  });

  test("observability: mastra gets framework bonus over langchain", () => {
    const mastra = assessAgent("a1", minimalAgent({ framework: "mastra" }));
    const lc = assessAgent("a2", minimalAgent({ framework: "langchain" }));
    const o1 = mastra.dimensions.find((d) => d.dimension === "observability")!;
    const o2 = lc.dimensions.find((d) => d.dimension === "observability")!;
    assert.ok(o1.score > o2.score);
  });

  test("observability: custom framework gets no tracing bonus", () => {
    const custom = assessAgent("a1", minimalAgent({ framework: "custom" }));
    const vercel = assessAgent("a2", minimalAgent({ framework: "vercel-ai" }));
    const o1 = custom.dimensions.find((d) => d.dimension === "observability")!;
    const o2 = vercel.dimensions.find((d) => d.dimension === "observability")!;
    assert.ok(o2.score > o1.score);
  });

  test("guardrails: mastra gets native guardrails bonus", () => {
    const mastra = assessAgent("a1", minimalAgent({ framework: "mastra" }));
    const openai = assessAgent("a2", minimalAgent({ framework: "openai" }));
    const g1 = mastra.dimensions.find((d) => d.dimension === "guardrails")!;
    const g2 = openai.dimensions.find((d) => d.dimension === "guardrails")!;
    assert.ok(g1.score > g2.score);
  });

  test("guardrails: bounded tools (1-15) gets bonus", () => {
    const bounded = assessAgent("a1", minimalAgent({ tools: ["a", "b", "c"] }));
    const unbounded = assessAgent("a2", minimalAgent({
      tools: Array.from({ length: 20 }, (_, i) => `t${i}`),
    }));
    const g1 = bounded.dimensions.find((d) => d.dimension === "guardrails")!;
    const g2 = unbounded.dimensions.find((d) => d.dimension === "guardrails")!;
    assert.ok(g1.score > g2.score);
  });

  test("all dimensions are clamped to 100 max", () => {
    const agent = assessAgent("a1", fullAgent());
    for (const dim of agent.dimensions) {
      assert.ok(dim.score <= 100, `${dim.dimension} score ${dim.score} exceeds 100`);
    }
  });

  test("all 7 dimensions are always present", () => {
    const agent = assessAgent("a1", minimalAgent());
    const dims = agent.dimensions.map((d) => d.dimension).sort();
    assert.deepEqual(dims, [
      "auditability", "compliance", "guardrails", "identity",
      "lifecycle", "observability", "permissions",
    ]);
  });
});

// ─── Composite Score ────────────────────────────────────────────

describe("composite score calculation", () => {
  test("full agent scores above 80", () => {
    const result = assessAgent("a1", fullAgent());
    assert.ok(result.compositeScore > 80);
  });

  test("minimal agent scores below 40", () => {
    const result = assessAgent("a1", minimalAgent());
    assert.ok(result.compositeScore < 40);
  });

  test("composite score is rounded integer", () => {
    const result = assessAgent("a1", fullAgent());
    assert.equal(result.compositeScore, Math.round(result.compositeScore));
  });

  test("composite score considers weights", () => {
    // Identity has weight 1.5, lifecycle has weight 0.8
    // An agent strong on identity should score differently
    // than one strong on lifecycle
    const identityStrong = assessAgent("a1", minimalAgent({
      framework: "mastra",
      hasAuth: true,
      description: "Strong identity",
      version: "2.0",
      channels: ["slack"],
    }));
    const lifecycleStrong = assessAgent("a2", minimalAgent({
      description: "Good lifecycle",
      version: "2.0",
      channels: ["api"],
      metadata: { env: "prod" },
    }));
    // Identity-strong should benefit more due to higher weight
    assert.ok(identityStrong.compositeScore >= lifecycleStrong.compositeScore);
  });
});

// ─── Status Derivation ──────────────────────────────────────────

describe("status derivation", () => {
  test("high-scoring agent is approved", () => {
    const result = assessAgent("a1", fullAgent());
    assert.equal(result.status, "approved");
  });

  test("low-scoring agent is flagged", () => {
    const result = assessAgent("a1", minimalAgent());
    assert.equal(result.status, "flagged");
  });

  test("agent with all features gets approved status", () => {
    const result = assessAgent("a1", fullAgent());
    assert.ok(result.compositeScore >= 60);
    assert.equal(result.status, "approved");
  });
});

// ─── Recommendations ────────────────────────────────────────────

describe("recommendation generation", () => {
  test("minimal agent gets multiple recommendations", () => {
    const result = assessAgent("a1", minimalAgent());
    assert.ok(result.recommendations.length > 0);
  });

  test("full agent gets certification recommendation", () => {
    const result = assessAgent("a1", fullAgent());
    assert.ok(result.recommendations.some((r) => r.includes("Level 4")));
  });

  test("no guardrails generates guardrails recommendation", () => {
    const result = assessAgent("a1", minimalAgent({ hasGuardrails: false }));
    assert.ok(result.recommendations.some((r) =>
      r.toLowerCase().includes("guardrail"),
    ));
  });

  test("no auth generates identity recommendation", () => {
    const result = assessAgent("a1", minimalAgent({
      framework: "unknown",
      hasAuth: false,
    }));
    assert.ok(result.recommendations.some((r) =>
      r.toLowerCase().includes("auth"),
    ));
  });
});

// ─── Fleet Assessment ───────────────────────────────────────────

describe("assessFleet", () => {
  test("empty fleet", () => {
    const result = assessFleet([]);
    assert.equal(result.summary.totalAgents, 0);
    assert.equal(result.summary.averageScore, 0);
    assert.equal(result.summary.highestScoring, null);
    assert.equal(result.assessments.length, 0);
  });

  test("single agent fleet", () => {
    const result = assessFleet([
      { id: "a1", registration: fullAgent() },
    ]);
    assert.equal(result.summary.totalAgents, 1);
    assert.ok(result.summary.averageScore > 0);
    assert.equal(result.summary.highestScoring?.name, "full-agent");
    assert.equal(result.summary.lowestScoring?.name, "full-agent");
  });

  test("mixed fleet has correct high/low agents", () => {
    const result = assessFleet([
      { id: "a1", registration: fullAgent({ name: "best" }) },
      { id: "a2", registration: minimalAgent({ name: "worst" }) },
    ]);
    assert.equal(result.summary.highestScoring?.name, "best");
    assert.equal(result.summary.lowestScoring?.name, "worst");
  });

  test("fleet tracks agents by framework", () => {
    const result = assessFleet([
      { id: "a1", registration: fullAgent({ framework: "mastra" }) },
      { id: "a2", registration: minimalAgent({ framework: "langchain" }) },
      { id: "a3", registration: minimalAgent({ framework: "mastra" }) },
    ]);
    assert.equal(result.summary.byFramework["mastra"], 2);
    assert.equal(result.summary.byFramework["langchain"], 1);
  });

  test("fleet tracks agents by level", () => {
    const result = assessFleet([
      { id: "a1", registration: fullAgent() },
      { id: "a2", registration: minimalAgent() },
    ]);
    assert.ok(result.summary.byLevel[4] >= 0);
    assert.ok(result.summary.byLevel[0] >= 0);
  });

  test("fleet tracks agents by status", () => {
    const result = assessFleet([
      { id: "a1", registration: fullAgent() },
      { id: "a2", registration: minimalAgent() },
    ]);
    assert.ok(result.summary.byStatus.approved >= 0);
    assert.ok(result.summary.byStatus.flagged >= 0);
  });

  test("fleet recommendations for low average", () => {
    const result = assessFleet([
      { id: "a1", registration: minimalAgent() },
      { id: "a2", registration: minimalAgent() },
    ]);
    assert.ok(result.summary.recommendations.some((r) =>
      r.includes("below 60"),
    ));
  });

  test("fleet recommendations for flagged agents", () => {
    const result = assessFleet([
      { id: "a1", registration: fullAgent() },
      { id: "a2", registration: minimalAgent() },
    ]);
    assert.ok(result.summary.recommendations.some((r) =>
      r.includes("below governance threshold"),
    ));
  });

  test("all agents identical scores", () => {
    const reg = minimalAgent({ framework: "mastra" });
    const result = assessFleet([
      { id: "a1", registration: reg },
      { id: "a2", registration: reg },
      { id: "a3", registration: reg },
    ]);
    // All scores should be the same
    const scores = result.assessments.map((a) => a.compositeScore);
    assert.ok(scores.every((s) => s === scores[0]));
  });
});

// ─── Assessment Structure ───────────────────────────────────────

describe("assessment structure", () => {
  test("assessment has correct agentId", () => {
    const result = assessAgent("my-id", fullAgent());
    assert.equal(result.agentId, "my-id");
  });

  test("assessment has correct agentName", () => {
    const result = assessAgent("a1", fullAgent({ name: "my-agent" }));
    assert.equal(result.agentName, "my-agent");
  });

  test("assessment has ISO timestamp", () => {
    const result = assessAgent("a1", fullAgent());
    assert.ok(result.assessedAt);
    assert.ok(!isNaN(Date.parse(result.assessedAt)));
  });

  test("each dimension has evidence object", () => {
    const result = assessAgent("a1", fullAgent());
    for (const dim of result.dimensions) {
      assert.ok(dim.evidence);
      assert.ok(typeof dim.evidence === "object");
    }
  });
});
