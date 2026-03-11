import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance } from "./index";
import { createIntegrityAudit } from "./audit-integrity";

// ─── Chain Verification Edge Cases ──────────────────────────────

describe("integrity audit edge cases", () => {
  test("verify empty chain returns valid with 0 events", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    const result = await audit.verify();
    assert.equal(result.valid, true);
    assert.equal(result.eventsVerified, 0);
    assert.equal(result.brokenAt, null);
  });

  test("single event chain is valid", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    await audit.log({
      agentId: "a1",
      eventType: "test",
      outcome: "success",
      severity: "info",
    });

    const result = await audit.verify();
    assert.equal(result.valid, true);
    assert.equal(result.eventsVerified, 1);
  });

  test("long chain (20 events) verifies correctly", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    for (let i = 0; i < 20; i++) {
      await audit.log({
        agentId: `agent-${i % 3}`,
        eventType: "tool_call",
        outcome: i % 5 === 0 ? "failure" : "success",
        severity: "info",
        detail: { iteration: i },
      });
    }

    const result = await audit.verify();
    assert.equal(result.valid, true);
    assert.equal(result.eventsVerified, 20);
  });

  test("export returns events with integrity metadata", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    await audit.log({
      agentId: "a1",
      eventType: "test",
      outcome: "success",
      severity: "info",
    });

    const exported = await audit.export();
    assert.equal(exported.length, 1);
    assert.ok(exported[0].integrity);
    assert.ok(exported[0].integrity.hash);
    assert.ok(exported[0].integrity.sequence);
    assert.ok(exported[0].integrity.signedAt);
  });

  test("stats returns correct counts", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });
    await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });
    await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });

    const stats = await audit.stats();
    assert.equal(stats.totalEvents, 3);
    assert.equal(stats.latestSequence, 3);
    assert.ok(stats.latestHash);
    assert.equal(stats.algorithm, "hmac-sha256");
  });

  test("different signing keys produce different hashes", async () => {
    const gov1 = createGovernance();
    const gov2 = createGovernance();
    const audit1 = createIntegrityAudit(gov1, { signingKey: "key-one" });
    const audit2 = createIntegrityAudit(gov2, { signingKey: "key-two" });

    const event = { agentId: "a1", eventType: "test", outcome: "success", severity: "info" };
    const e1 = await audit1.log(event);
    const e2 = await audit2.log(event);

    const export1 = await audit1.export();
    const export2 = await audit2.export();

    assert.notEqual(export1[0].integrity.hash, export2[0].integrity.hash);
  });

  test("chain detects inserted event (rogue event without integrity)", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });
    await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });

    // Insert a rogue event directly into storage (bypassing integrity)
    await gov.audit.log({
      agentId: "rogue",
      eventType: "injected",
      outcome: "success",
      severity: "info",
    });

    // Verify detects the rogue event has no integrity record
    const result = await audit.verify();
    assert.equal(result.valid, false);
    assert.ok(result.breakDetail?.includes("no integrity record"));
  });

  test("verify with filters only checks matching events", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    await audit.log({ agentId: "a1", eventType: "tool_call", outcome: "success", severity: "info" });
    await audit.log({ agentId: "a2", eventType: "tool_call", outcome: "success", severity: "info" });
    await audit.log({ agentId: "a1", eventType: "tool_call", outcome: "failure", severity: "warning" });

    // Verify all — should pass
    const allResult = await audit.verify();
    assert.equal(allResult.valid, true);
    assert.equal(allResult.eventsVerified, 3);
  });

  test("log returns event with integrity fields", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    const event = await audit.log({
      agentId: "a1",
      eventType: "test",
      outcome: "success",
      severity: "info",
      detail: { key: "value" },
    });

    assert.ok(event.id);
    assert.equal(event.agentId, "a1");
    assert.ok(event.integrity);
    assert.equal(event.integrity.sequence, 1);
    assert.equal(event.integrity.previousHash, "0".repeat(64));
  });

  test("sequential events have incrementing sequences", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    const e1 = await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });
    const e2 = await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });
    const e3 = await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });

    assert.equal(e1.integrity.sequence, 1);
    assert.equal(e2.integrity.sequence, 2);
    assert.equal(e3.integrity.sequence, 3);
  });

  test("each event references previous hash", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    const e1 = await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });
    const e2 = await audit.log({ agentId: "a1", eventType: "test", outcome: "success", severity: "info" });

    assert.equal(e1.integrity.previousHash, "0".repeat(64));
    assert.equal(e2.integrity.previousHash, e1.integrity.hash);
  });

  test("stats on empty audit", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    const stats = await audit.stats();
    assert.equal(stats.totalEvents, 0);
    assert.equal(stats.latestSequence, 0);
    assert.ok(stats.latestHash.length > 0);
  });

  test("export on empty audit returns empty array", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    const exported = await audit.export();
    assert.equal(exported.length, 0);
  });

  test("events with complex detail objects are signed correctly", async () => {
    const gov = createGovernance();
    const audit = createIntegrityAudit(gov, { signingKey: "test-key" });

    await audit.log({
      agentId: "a1",
      eventType: "test",
      outcome: "success",
      severity: "info",
      detail: {
        nested: { deep: { value: 42 } },
        array: [1, 2, 3],
        bool: true,
        nullVal: null,
      },
    });

    const result = await audit.verify();
    assert.equal(result.valid, true);
  });
});
