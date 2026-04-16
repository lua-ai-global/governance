/**
 * Integration test: the HMAC integrity chain must survive process restart.
 *
 * Simulates the restart by discarding the original createGovernance()
 * instance (closures gone, chain state lost) and creating a fresh one
 * against the same storage. The second instance must resume the chain
 * and produce events whose sequence continues from where the first
 * instance left off, with verifyAuditIntegrity passing end-to-end.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, createMemoryStorage } from "./index.js";
import { verifyAuditIntegrity } from "./audit-integrity-verify.js";
import type { GovernanceStorage } from "./storage.js";

const KEY = "test-signing-key-0.12-restart";

async function writeSomeEvents(gov: Awaited<ReturnType<typeof createGovernance>>, count: number) {
  for (let i = 0; i < count; i++) {
    await gov.audit.log({
      agentId: "restart-agent",
      eventType: "test_event",
      outcome: "success",
      severity: "info",
      detail: { iteration: i },
    });
  }
}

describe("integrity chain restart durability (0.12)", () => {
  it("resumes sequence from storage on fresh createGovernance() call", async () => {
    const storage: GovernanceStorage = createMemoryStorage();

    const gov1 = createGovernance({ storage, integrityAudit: { signingKey: KEY } });
    await writeSomeEvents(gov1, 5);
    const stats1 = gov1.integrityChain!.stats();
    assert.equal(stats1.latestSequence, 5, "first instance wrote sequences 1..5");
    const firstHash = stats1.latestHash;

    // Simulate restart: drop gov1 entirely, keep storage.
    const gov2 = createGovernance({ storage, integrityAudit: { signingKey: KEY } });
    // Write one more event — must pick up at sequence 6 and chain to firstHash.
    await writeSomeEvents(gov2, 1);
    const stats2 = gov2.integrityChain!.stats();
    assert.equal(stats2.latestSequence, 6, "second instance resumed at sequence 6");
    assert.notEqual(stats2.latestHash, firstHash, "new event produced new head");

    // Full chain must verify end-to-end across the boundary.
    const chain = await gov2.integrityChain!.export();
    assert.equal(chain.length, 6, "export includes all 6 events");
    assert.deepEqual(
      chain.map((e) => e.integrity.sequence),
      [1, 2, 3, 4, 5, 6],
      "sequences are contiguous across restart",
    );

    const verification = await verifyAuditIntegrity(chain, KEY);
    assert.equal(verification.valid, true, verification.breakDetail ?? "chain should verify");
    assert.equal(verification.eventsVerified, 6);
  });

  it("getChainHead returns null for empty storage (cold start)", async () => {
    const storage = createMemoryStorage();
    const head = await storage.getChainHead!();
    assert.equal(head, null);
  });

  it("legacy storage adapter (no createAuditEventWithIntegrity) still works but warns", async () => {
    // Build an adapter that implements the core interface but omits the
    // new integrity methods, emulating a third-party 0.11.x adapter.
    const base = createMemoryStorage();
    const legacy: GovernanceStorage = {
      createAgent: base.createAgent,
      getAgent: base.getAgent,
      getAgentByName: base.getAgentByName,
      listAgents: base.listAgents,
      updateAgent: base.updateAgent,
      deleteAgent: base.deleteAgent,
      createAuditEvent: base.createAuditEvent,
      queryAuditEvents: base.queryAuditEvents,
      countAuditEvents: base.countAuditEvents,
      // intentionally omit: createAuditEventWithIntegrity, getChainHead, getAuditIntegrity
    };

    const warnings: unknown[] = [];
    const gov = createGovernance({
      storage: legacy,
      integrityAudit: { signingKey: KEY },
      onAuditError: (e) => warnings.push(e),
    });

    await writeSomeEvents(gov, 2);
    const chain = await gov.integrityChain!.export();
    assert.equal(chain.length, 2, "chain export still works via in-memory fallback");
    const verification = await verifyAuditIntegrity(chain, KEY);
    assert.equal(verification.valid, true);
    assert.ok(
      warnings.length >= 2,
      "onAuditError fired at least once per write on legacy adapter",
    );
    assert.ok(
      warnings.every((w) => w instanceof Error && /chain is session-local/.test(w.message)),
      "warning explains the session-local downgrade",
    );
  });
});
