import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DIMENSION_SCORERS, DIMENSION_WEIGHTS } from "./scorer-dimensions";
import type { AgentRegistration } from "./types";

function makeAgent(overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  return { name: "test-agent", framework: "mastra", owner: "team", ...overrides };
}

const ALL_DIMENSIONS = ["identity", "permissions", "observability", "guardrails", "auditability", "compliance", "lifecycle"] as const;

describe("DIMENSION_WEIGHTS", () => {
  test("all 7 dimensions have weights", () => {
    for (const dim of ALL_DIMENSIONS) {
      assert.ok(typeof DIMENSION_WEIGHTS[dim] === "number", `Missing weight for ${dim}`);
      assert.ok(DIMENSION_WEIGHTS[dim] > 0, `Weight for ${dim} must be positive`);
    }
  });

  test("identity and permissions have highest weights", () => {
    assert.ok(DIMENSION_WEIGHTS.identity >= DIMENSION_WEIGHTS.lifecycle);
    assert.ok(DIMENSION_WEIGHTS.permissions >= DIMENSION_WEIGHTS.lifecycle);
  });
});

describe("DIMENSION_SCORERS", () => {
  test("all 7 dimensions have scorer functions", () => {
    for (const dim of ALL_DIMENSIONS) {
      assert.ok(typeof DIMENSION_SCORERS[dim] === "function", `Missing scorer for ${dim}`);
    }
  });

  test("all scorers return valid DimensionResult", () => {
    const agent = makeAgent();
    for (const dim of ALL_DIMENSIONS) {
      const result = DIMENSION_SCORERS[dim](agent);
      assert.equal(result.dimension, dim);
      assert.ok(result.score >= 0, `${dim} score must be >= 0`);
      assert.ok(result.score <= 100, `${dim} score must be <= 100`);
      assert.ok(result.weight > 0, `${dim} weight must be positive`);
      assert.ok(result.evidence, `${dim} must have evidence`);
    }
  });

  test("scores are capped at 100", () => {
    const maxAgent = makeAgent({
      description: "Full agent", version: "2.0.0", channels: ["slack"],
      tools: ["a", "b"], permissions: { read: true },
      hasAuth: true, hasGuardrails: true, hasObservability: true, hasAuditLog: true,
      metadata: { team: "eng" },
    });
    for (const dim of ALL_DIMENSIONS) {
      const result = DIMENSION_SCORERS[dim](maxAgent);
      assert.ok(result.score <= 100, `${dim} exceeded 100: ${result.score}`);
    }
  });

  test("scores are at least 0", () => {
    const minAgent = makeAgent({ name: "", framework: "unknown", owner: "" });
    for (const dim of ALL_DIMENSIONS) {
      const result = DIMENSION_SCORERS[dim](minAgent);
      assert.ok(result.score >= 0, `${dim} below 0: ${result.score}`);
    }
  });
});

describe("identity scorer", () => {
  test("name contributes to score", () => {
    const withName = DIMENSION_SCORERS.identity(makeAgent({ name: "test" }));
    const noName = DIMENSION_SCORERS.identity(makeAgent({ name: "" }));
    assert.ok(withName.score > noName.score);
  });

  test("auth boosts score", () => {
    const withAuth = DIMENSION_SCORERS.identity(makeAgent({ hasAuth: true }));
    const noAuth = DIMENSION_SCORERS.identity(makeAgent({ hasAuth: false }));
    assert.ok(withAuth.score > noAuth.score);
  });

  test("description boosts score", () => {
    const withDesc = DIMENSION_SCORERS.identity(makeAgent({ description: "Does stuff" }));
    const noDesc = DIMENSION_SCORERS.identity(makeAgent());
    assert.ok(withDesc.score > noDesc.score);
  });

  test("known framework scores higher than unknown", () => {
    const known = DIMENSION_SCORERS.identity(makeAgent({ framework: "mastra" }));
    const unknown = DIMENSION_SCORERS.identity(makeAgent({ framework: "unknown" }));
    assert.ok(known.score > unknown.score);
  });
});

describe("permissions scorer", () => {
  test("permissions object boosts score", () => {
    const withPerms = DIMENSION_SCORERS.permissions(makeAgent({ permissions: { read: true } }));
    const noPerms = DIMENSION_SCORERS.permissions(makeAgent());
    assert.ok(withPerms.score > noPerms.score);
  });

  test("bounded tools score higher than no tools", () => {
    const withTools = DIMENSION_SCORERS.permissions(makeAgent({ tools: ["a", "b", "c"] }));
    const noTools = DIMENSION_SCORERS.permissions(makeAgent());
    assert.ok(withTools.score > noTools.score);
  });

  test("fewer tools score higher than many", () => {
    const fewTools = DIMENSION_SCORERS.permissions(makeAgent({ tools: ["a", "b"] }));
    const manyTools = DIMENSION_SCORERS.permissions(makeAgent({ tools: Array.from({ length: 10 }, (_, i) => `t${i}`) }));
    assert.ok(fewTools.score >= manyTools.score);
  });
});

describe("observability scorer", () => {
  test("observability flag boosts score significantly", () => {
    const withObs = DIMENSION_SCORERS.observability(makeAgent({ hasObservability: true }));
    const noObs = DIMENSION_SCORERS.observability(makeAgent());
    assert.ok(withObs.score - noObs.score >= 30);
  });

  test("mastra framework gets tracing bonus", () => {
    const mastra = DIMENSION_SCORERS.observability(makeAgent({ framework: "mastra" }));
    const custom = DIMENSION_SCORERS.observability(makeAgent({ framework: "custom" }));
    assert.ok(mastra.score > custom.score);
  });
});

describe("guardrails scorer", () => {
  test("guardrails flag is the biggest contributor", () => {
    const withGuard = DIMENSION_SCORERS.guardrails(makeAgent({ hasGuardrails: true }));
    const noGuard = DIMENSION_SCORERS.guardrails(makeAgent());
    assert.ok(withGuard.score - noGuard.score >= 30);
  });
});

describe("auditability scorer", () => {
  test("audit log is the biggest contributor", () => {
    const withAudit = DIMENSION_SCORERS.auditability(makeAgent({ hasAuditLog: true }));
    const noAudit = DIMENSION_SCORERS.auditability(makeAgent());
    assert.ok(withAudit.score - noAudit.score >= 30);
  });
});

describe("compliance scorer", () => {
  test("all flags together score high", () => {
    const full = DIMENSION_SCORERS.compliance(makeAgent({
      hasAuditLog: true, hasGuardrails: true, hasAuth: true,
      hasObservability: true, permissions: { admin: true },
    }));
    assert.ok(full.score >= 90);
  });
});

describe("lifecycle scorer", () => {
  test("owner and version are key contributors", () => {
    const full = DIMENSION_SCORERS.lifecycle(makeAgent({ version: "2.0", description: "test", metadata: {} }));
    const minimal = DIMENSION_SCORERS.lifecycle(makeAgent({ owner: "", framework: "unknown" }));
    assert.ok(full.score > minimal.score);
  });

  test("channels boost lifecycle score", () => {
    const withChannels = DIMENSION_SCORERS.lifecycle(makeAgent({ channels: ["slack"] }));
    const noChannels = DIMENSION_SCORERS.lifecycle(makeAgent());
    assert.ok(withChannels.score > noChannels.score);
  });
});
