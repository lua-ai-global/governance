import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernanceMetrics } from "./metrics";

describe("GovernanceMetrics", () => {
  test("creates metrics with all methods", () => {
    const m = createGovernanceMetrics();
    assert.ok(m.increment);
    assert.ok(m.timing);
    assert.ok(m.snapshot);
    assert.ok(m.reset);
  });

  test("increment creates counter on first call", () => {
    const m = createGovernanceMetrics();
    m.increment("enforcement.total");

    const snap = m.snapshot();
    const counter = snap.counters.find((c) => c.name === "enforcement.total");
    assert.ok(counter);
    assert.equal(counter.value, 1);
  });

  test("increment adds to existing counter", () => {
    const m = createGovernanceMetrics();
    m.increment("enforcement.total");
    m.increment("enforcement.total");
    m.increment("enforcement.total");

    const snap = m.snapshot();
    const counter = snap.counters.find((c) => c.name === "enforcement.total");
    assert.equal(counter?.value, 3);
  });

  test("labels create separate counters", () => {
    const m = createGovernanceMetrics();
    m.increment("enforcement.blocked", { agent: "sales-bot" });
    m.increment("enforcement.blocked", { agent: "research-bot" });
    m.increment("enforcement.blocked", { agent: "sales-bot" });

    const snap = m.snapshot();
    const blocked = snap.counters.filter((c) => c.name === "enforcement.blocked");
    assert.equal(blocked.length, 2);

    const salesBot = blocked.find((c) => c.labels.agent === "sales-bot");
    assert.equal(salesBot?.value, 2);

    const researchBot = blocked.find((c) => c.labels.agent === "research-bot");
    assert.equal(researchBot?.value, 1);
  });

  test("timing records single measurement", () => {
    const m = createGovernanceMetrics();
    m.timing("enforcement.duration_ms", 15.5);

    const snap = m.snapshot();
    const t = snap.timings.find((t) => t.name === "enforcement.duration_ms");
    assert.ok(t);
    assert.equal(t.count, 1);
    assert.equal(t.totalMs, 15.5);
    assert.equal(t.avgMs, 15.5);
    assert.equal(t.minMs, 15.5);
    assert.equal(t.maxMs, 15.5);
  });

  test("timing aggregates multiple measurements", () => {
    const m = createGovernanceMetrics();
    m.timing("enforcement.duration_ms", 10);
    m.timing("enforcement.duration_ms", 20);
    m.timing("enforcement.duration_ms", 30);

    const snap = m.snapshot();
    const t = snap.timings.find((t) => t.name === "enforcement.duration_ms");
    assert.ok(t);
    assert.equal(t.count, 3);
    assert.equal(t.totalMs, 60);
    assert.equal(t.avgMs, 20);
    assert.equal(t.minMs, 10);
    assert.equal(t.maxMs, 30);
  });

  test("snapshot includes timestamp and uptime", () => {
    const m = createGovernanceMetrics();

    const snap = m.snapshot();
    assert.ok(snap.collectedAt);
    assert.ok(!isNaN(Date.parse(snap.collectedAt)));
    assert.ok(snap.uptimeMs >= 0);
  });

  test("snapshot returns empty arrays when no data", () => {
    const m = createGovernanceMetrics();
    const snap = m.snapshot();
    assert.equal(snap.counters.length, 0);
    assert.equal(snap.timings.length, 0);
  });

  test("reset clears all counters and timings", () => {
    const m = createGovernanceMetrics();
    m.increment("enforcement.total");
    m.increment("enforcement.blocked");
    m.timing("enforcement.duration_ms", 10);

    m.reset();

    const snap = m.snapshot();
    assert.equal(snap.counters.length, 0);
    assert.equal(snap.timings.length, 0);
  });

  test("multiple metric types tracked independently", () => {
    const m = createGovernanceMetrics();
    m.increment("enforcement.total");
    m.increment("enforcement.blocked");
    m.increment("enforcement.allowed");
    m.increment("registration.total");
    m.increment("audit.total");
    m.increment("injection.detected");

    const snap = m.snapshot();
    assert.equal(snap.counters.length, 6);
  });

  test("label order does not affect counter identity", () => {
    const m = createGovernanceMetrics();
    m.increment("enforcement.blocked", { agent: "bot", team: "sales" });
    m.increment("enforcement.blocked", { team: "sales", agent: "bot" });

    const snap = m.snapshot();
    const blocked = snap.counters.filter((c) => c.name === "enforcement.blocked");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].value, 2);
  });

  test("timing min/max track extremes", () => {
    const m = createGovernanceMetrics();
    m.timing("enforcement.duration_ms", 100);
    m.timing("enforcement.duration_ms", 1);
    m.timing("enforcement.duration_ms", 50);

    const snap = m.snapshot();
    const t = snap.timings.find((t) => t.name === "enforcement.duration_ms");
    assert.equal(t?.minMs, 1);
    assert.equal(t?.maxMs, 100);
  });

  test("counters no labels vs with labels are separate", () => {
    const m = createGovernanceMetrics();
    m.increment("enforcement.total");
    m.increment("enforcement.total", { agent: "bot" });

    const snap = m.snapshot();
    const totals = snap.counters.filter((c) => c.name === "enforcement.total");
    assert.equal(totals.length, 2);
  });

  test("all metric names are accepted", () => {
    const m = createGovernanceMetrics();
    m.increment("enforcement.total");
    m.increment("enforcement.blocked");
    m.increment("enforcement.allowed");
    m.increment("enforcement.require_approval");
    m.increment("registration.total");
    m.increment("audit.total");
    m.increment("audit.failures");
    m.increment("kill_switch.activations");
    m.increment("kill_switch.revocations");
    m.increment("injection.detected");
    m.increment("injection.clean");
    m.increment("policy.rules_evaluated");

    const snap = m.snapshot();
    assert.equal(snap.counters.length, 12);
  });

  test("all timing names are accepted", () => {
    const m = createGovernanceMetrics();
    m.timing("enforcement.duration_ms", 10);
    m.timing("registration.duration_ms", 5);

    const snap = m.snapshot();
    assert.equal(snap.timings.length, 2);
  });
});
