import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeSignals,
  computeBehavioralAdjustments,
  applyBehavioralAdjustments,
} from "./behavioral-scorer";
import type { AuditEvent } from "./storage";
import type { DimensionResult } from "./types";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: crypto.randomUUID(),
    agentId: "agent-1",
    eventType: "policy_evaluation",
    outcome: "allow",
    severity: "info",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvents(count: number, overrides: Partial<AuditEvent> = {}): AuditEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent({
      createdAt: new Date(Date.now() - i * 3600000).toISOString(),
      ...overrides,
    })
  );
}

describe("computeSignals", () => {
  it("returns zeroes for empty events", () => {
    const signals = computeSignals({ events: [], declaredTools: [] });
    assert.equal(signals.totalEvents, 0);
    assert.equal(signals.blockRate, 0);
    assert.equal(signals.lastActivityAt, null);
  });

  it("computes recency-weighted block rate", () => {
    const events = [
      ...makeEvents(7),
      ...makeEvents(3, { outcome: "block" }),
    ];
    // With recency bias, blocked events at end of list weigh more
    const signals = computeSignals({ events, declaredTools: [] });
    assert.equal(signals.totalEvents, 10);
    // Block rate should be in the ballpark of 30% but weighted toward recent events
    assert.ok(signals.blockRate > 0.2, `Block rate ${signals.blockRate} should be > 0.2`);
    assert.ok(signals.blockRate < 0.5, `Block rate ${signals.blockRate} should be < 0.5`);

    // With no recency bias, should be exactly 0.3
    const flat = computeSignals({ events, declaredTools: [], config: { recencyBias: 0 } });
    assert.ok(Math.abs(flat.blockRate - 0.3) < 0.01, "Flat weighting should give exact 0.3");
  });

  it("detects undeclared tools", () => {
    const events = [
      makeEvent({ detail: { tool: "web_search" } }),
      makeEvent({ detail: { tool: "shell_exec" } }),
      makeEvent({ detail: { tool: "db_query" } }),
    ];
    const signals = computeSignals({ events, declaredTools: ["web_search"] });
    assert.deepEqual(signals.undeclaredTools.sort(), ["db_query", "shell_exec"]);
    assert.equal(signals.uniqueToolsObserved.length, 3);
  });

  it("counts injection hits", () => {
    const events = [
      makeEvent({ eventType: "injection_detected" }),
      makeEvent({ eventType: "injection_detected" }),
      makeEvent(),
    ];
    const signals = computeSignals({ events, declaredTools: [] });
    assert.equal(signals.injectionHits, 2);
  });

  it("computes event frequency", () => {
    // 10 events over ~1 day
    const events = makeEvents(10);
    const signals = computeSignals({ events, declaredTools: [] });
    assert.ok(signals.eventFrequency > 0);
    assert.ok(signals.lastActivityAt !== null);
  });
});

describe("computeBehavioralAdjustments", () => {
  it("produces 7 adjustments (one per dimension)", () => {
    const result = computeBehavioralAdjustments({
      events: makeEvents(20),
      declaredTools: [],
    });
    assert.equal(result.adjustments.length, 7);
    const dims = result.adjustments.map((a) => a.dimension).sort();
    assert.deepEqual(dims, [
      "auditability", "compliance", "guardrails", "identity",
      "lifecycle", "observability", "permissions",
    ]);
  });

  it("penalizes undeclared tools on permissions", () => {
    const events = [
      makeEvent({ detail: { tool: "shell_exec" } }),
      makeEvent({ detail: { tool: "rm_rf" } }),
      makeEvent({ detail: { tool: "drop_table" } }),
    ];
    const result = computeBehavioralAdjustments({
      events,
      declaredTools: ["web_search"],
    });
    const perm = result.adjustments.find((a) => a.dimension === "permissions");
    assert.ok(perm);
    assert.ok(perm.adjustment < 0, "Should penalize undeclared tools");
  });

  it("rewards low block rate on permissions", () => {
    const result = computeBehavioralAdjustments({
      events: makeEvents(10),
      declaredTools: [],
    });
    const perm = result.adjustments.find((a) => a.dimension === "permissions");
    assert.ok(perm);
    assert.ok(perm.adjustment > 0, "Low block rate should be rewarded");
  });

  it("penalizes high block rate on guardrails", () => {
    const events = [
      ...makeEvents(3),
      ...makeEvents(7, { outcome: "block" }),
    ];
    const result = computeBehavioralAdjustments({
      events,
      declaredTools: [],
    });
    const guard = result.adjustments.find((a) => a.dimension === "guardrails");
    assert.ok(guard);
    assert.ok(guard.adjustment < 0, "High block rate should penalize guardrails");
  });

  it("penalizes any block rate on guardrails (blocks = bad agent behavior)", () => {
    const events = [
      ...makeEvents(8),
      ...makeEvents(2, { outcome: "block" }),
    ];
    const result = computeBehavioralAdjustments({
      events,
      declaredTools: [],
    });
    const guard = result.adjustments.find((a) => a.dimension === "guardrails");
    assert.ok(guard);
    assert.ok(guard.adjustment < 0, "Any blocks = agent triggered guardrails = negative");
  });

  it("rewards high event volume on observability", () => {
    const result = computeBehavioralAdjustments({
      events: makeEvents(60),
      declaredTools: [],
    });
    const obs = result.adjustments.find((a) => a.dimension === "observability");
    assert.ok(obs);
    assert.equal(obs.adjustment, 10);
  });

  it("penalizes frequent policy violations on compliance", () => {
    const events = [
      ...makeEvents(3),
      ...makeEvents(7, { outcome: "block" }),
    ];
    const result = computeBehavioralAdjustments({
      events,
      declaredTools: [],
    });
    const comp = result.adjustments.find((a) => a.dimension === "compliance");
    assert.ok(comp);
    assert.ok(comp.adjustment < 0);
  });

  it("returns zero adjustments for no events", () => {
    const result = computeBehavioralAdjustments({
      events: [],
      declaredTools: [],
    });
    for (const adj of result.adjustments) {
      assert.equal(adj.adjustment, 0);
    }
  });

  it("clamps adjustments to [-20, 20]", () => {
    // 10 undeclared tools — would be -50 without clamping
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ detail: { tool: `rogue_tool_${i}` } })
    );
    const result = computeBehavioralAdjustments({
      events,
      declaredTools: [],
    });
    for (const adj of result.adjustments) {
      assert.ok(adj.adjustment >= -20);
      assert.ok(adj.adjustment <= 20);
    }
  });
});

describe("applyBehavioralAdjustments", () => {
  it("adjusts dimension scores", () => {
    const base: DimensionResult[] = [
      { dimension: "permissions", score: 50, weight: 1.5, evidence: {} },
      { dimension: "guardrails", score: 60, weight: 1.3, evidence: {} },
    ];
    const adjustments = [
      { dimension: "permissions" as const, adjustment: -10, evidence: { reason: "undeclared tools" } },
      { dimension: "guardrails" as const, adjustment: 10, evidence: { reason: "working well" } },
    ];
    const result = applyBehavioralAdjustments(base, adjustments);
    assert.equal(result[0].score, 40);
    assert.equal(result[1].score, 70);
  });

  it("clamps adjusted scores to 0-100", () => {
    const base: DimensionResult[] = [
      { dimension: "permissions", score: 5, weight: 1.5, evidence: {} },
      { dimension: "guardrails", score: 95, weight: 1.3, evidence: {} },
    ];
    const adjustments = [
      { dimension: "permissions" as const, adjustment: -20, evidence: {} },
      { dimension: "guardrails" as const, adjustment: 20, evidence: {} },
    ];
    const result = applyBehavioralAdjustments(base, adjustments);
    assert.equal(result[0].score, 0);
    assert.equal(result[1].score, 100);
  });

  it("preserves dimensions without adjustments", () => {
    const base: DimensionResult[] = [
      { dimension: "identity", score: 70, weight: 1.5, evidence: { hasName: true } },
    ];
    const result = applyBehavioralAdjustments(base, []);
    assert.equal(result[0].score, 70);
    assert.deepEqual(result[0].evidence, { hasName: true });
  });

  it("merges behavioral evidence into dimension evidence", () => {
    const base: DimensionResult[] = [
      { dimension: "permissions", score: 50, weight: 1.5, evidence: { hasPermissions: true } },
    ];
    const adjustments = [
      { dimension: "permissions" as const, adjustment: -5, evidence: { undeclaredToolCount: 2 } },
    ];
    const result = applyBehavioralAdjustments(base, adjustments);
    assert.equal(result[0].evidence.hasPermissions, true);
    assert.equal(result[0].evidence.behavioralAdjustment, -5);
    assert.equal(result[0].evidence.behavioral_undeclaredToolCount, 2);
  });
});
