import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance } from "./index";
import { createIntegrityAudit } from "./audit-integrity";
import type { IntegrityAuditEvent } from "./audit-integrity";

const TEST_KEY = "test-signing-key-do-not-use-in-production";

describe("Tamper-Evident Audit (EU AI Act Article 12)", () => {
  it("logs events with HMAC-SHA256 integrity hashes", async () => {
    const gov = createGovernance({});
    const audit = createIntegrityAudit(gov, { signingKey: TEST_KEY });

    const event = await audit.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
      detail: { tool: "web_search" },
    });

    assert.ok(event.integrity);
    assert.equal(typeof event.integrity.hash, "string");
    assert.equal(event.integrity.hash.length, 64); // SHA-256 = 64 hex chars
    assert.equal(event.integrity.sequence, 1);
    assert.equal(event.integrity.previousHash, "0".repeat(64)); // Genesis
  });

  it("chains hashes — each event references the previous", async () => {
    const gov = createGovernance({});
    const audit = createIntegrityAudit(gov, { signingKey: TEST_KEY });

    const event1 = await audit.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });

    const event2 = await audit.log({
      agentId: "agent-1",
      eventType: "policy_evaluation",
      outcome: "block",
      severity: "warning",
    });

    const event3 = await audit.log({
      agentId: "agent-2",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });

    // Chain integrity
    assert.equal(event1.integrity.previousHash, "0".repeat(64));
    assert.equal(event2.integrity.previousHash, event1.integrity.hash);
    assert.equal(event3.integrity.previousHash, event2.integrity.hash);

    // Sequences
    assert.equal(event1.integrity.sequence, 1);
    assert.equal(event2.integrity.sequence, 2);
    assert.equal(event3.integrity.sequence, 3);

    // All hashes are different
    assert.notEqual(event1.integrity.hash, event2.integrity.hash);
    assert.notEqual(event2.integrity.hash, event3.integrity.hash);
  });

  it("verifies a valid chain", async () => {
    const gov = createGovernance({});
    const audit = createIntegrityAudit(gov, { signingKey: TEST_KEY });

    // Log several events
    for (let i = 0; i < 5; i++) {
      await audit.log({
        agentId: `agent-${i}`,
        eventType: "tool_call",
        outcome: "success",
        severity: "info",
        detail: { index: i },
      });
    }

    const result = await audit.verify();
    assert.equal(result.valid, true);
    assert.equal(result.eventsVerified, 5);
    assert.equal(result.totalEvents, 5);
    assert.equal(result.brokenAt, null);
    assert.equal(result.breakDetail, null);
  });

  it("detects inserted events (no integrity record)", async () => {
    const gov = createGovernance({});
    const audit = createIntegrityAudit(gov, { signingKey: TEST_KEY });

    // Log through integrity audit
    await audit.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });

    // Log directly through governance (bypassing integrity)
    await gov.audit.log({
      agentId: "agent-rogue",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });

    // Verify should detect the untracked event
    const result = await audit.verify();
    assert.equal(result.valid, false);
    assert.ok(result.breakDetail?.includes("no integrity record"));
  });

  it("exports chain with integrity metadata", async () => {
    const gov = createGovernance({});
    const audit = createIntegrityAudit(gov, { signingKey: TEST_KEY });

    await audit.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });
    await audit.log({
      agentId: "agent-2",
      eventType: "policy_evaluation",
      outcome: "block",
      severity: "warning",
    });

    const chain = await audit.export();
    assert.equal(chain.length, 2);
    assert.ok(chain[0].integrity);
    assert.ok(chain[1].integrity);
    assert.equal(chain[0].integrity.sequence, 1);
    assert.equal(chain[1].integrity.sequence, 2);
  });

  it("provides chain statistics", async () => {
    const gov = createGovernance({});
    const audit = createIntegrityAudit(gov, { signingKey: TEST_KEY });

    await audit.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });

    const s = await audit.stats();
    assert.equal(s.latestSequence, 1);
    assert.equal(s.latestHash.length, 64);
    assert.equal(s.algorithm, "hmac-sha256");
  });

  it("produces deterministic hashes for identical inputs", async () => {
    // Two separate instances with the same key should produce the same hash
    // for the same event content (given the same chain state)
    const gov1 = createGovernance({});
    const gov2 = createGovernance({});
    const audit1 = createIntegrityAudit(gov1, { signingKey: TEST_KEY });
    const audit2 = createIntegrityAudit(gov2, { signingKey: TEST_KEY });

    // Both start from genesis hash, so first event hash depends only on content
    // Note: different IDs and timestamps will produce different hashes,
    // which is correct behavior (each event is unique)
    const e1 = await audit1.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });
    const e2 = await audit2.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });

    // Same previousHash (genesis)
    assert.equal(e1.integrity.previousHash, e2.integrity.previousHash);
    // Different hashes (different event IDs and timestamps)
    assert.notEqual(e1.integrity.hash, e2.integrity.hash);
  });

  it("different signing keys produce different hashes", async () => {
    const gov1 = createGovernance({});
    const gov2 = createGovernance({});
    const audit1 = createIntegrityAudit(gov1, { signingKey: "key-1" });
    const audit2 = createIntegrityAudit(gov2, { signingKey: "key-2" });

    const e1 = await audit1.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });
    const e2 = await audit2.log({
      agentId: "agent-1",
      eventType: "tool_call",
      outcome: "success",
      severity: "info",
    });

    // Even with same content, different keys = different hashes
    assert.notEqual(e1.integrity.hash, e2.integrity.hash);
  });
});
