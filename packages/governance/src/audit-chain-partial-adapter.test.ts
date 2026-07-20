/**
 * Partial-adapter capability detection for the integrity chain.
 *
 * A custom storage adapter may implement only a SUBSET of the integrity
 * contract. Two subsets that shipped adapters never exercise (Postgres +
 * memory implement everything) but that the multi-process README actively
 * encourages custom adapters to adopt:
 *
 *   1. appendToAuditChain + getAuditIntegrity, WITHOUT the legacy
 *      createAuditEventWithIntegrity. Writes persist durable integrity via the
 *      new atomic-append contract; export()/verify() must read it back through
 *      getAuditIntegrity rather than an empty in-process index.
 *   2. createAuditEventWithIntegrity + getAuditIntegrity, WITHOUT
 *      appendToAuditChain. Durable but process-local sequence allocation —
 *      only safe under a single writer. The SDK must emit the documented
 *      one-time advisory so multi-process deployments aren't silently unsafe.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, createMemoryStorage } from "./index.js";
import { verifyAuditIntegrity } from "./audit-integrity-verify.js";
import type { GovernanceStorage } from "./storage.js";

const KEY = "partial-adapter-test-secret";

async function writeN(gov: Awaited<ReturnType<typeof createGovernance>>, count: number) {
  for (let i = 0; i < count; i++) {
    await gov.audit.log({
      agentId: "partial-agent",
      eventType: "test_event",
      outcome: "success",
      severity: "info",
      detail: { iteration: i },
    });
  }
}

/** Core (non-integrity) storage surface, copied from a memory base. */
function coreSurface(base: GovernanceStorage) {
  return {
    createAgent: base.createAgent,
    getAgent: base.getAgent,
    getAgentByName: base.getAgentByName,
    listAgents: base.listAgents,
    updateAgent: base.updateAgent,
    deleteAgent: base.deleteAgent,
    createAuditEvent: base.createAuditEvent,
    queryAuditEvents: base.queryAuditEvents,
    countAuditEvents: base.countAuditEvents,
  };
}

describe("integrity chain — partial storage adapters", () => {
  it("exports + verifies for an appendToAuditChain-only adapter (no createAuditEventWithIntegrity)", async () => {
    const base = createMemoryStorage();
    // New write contract + durable read, but NO legacy write method.
    const atomicOnly: GovernanceStorage = {
      ...coreSurface(base),
      appendToAuditChain: base.appendToAuditChain,
      getChainHead: base.getChainHead,
      getAuditIntegrity: base.getAuditIntegrity,
      // intentionally omit: createAuditEventWithIntegrity
    };

    const gov = createGovernance({ storage: atomicOnly, integrityAudit: { signingKey: KEY } });
    await writeN(gov, 4);

    const chain = await gov.integrityChain!.export();
    assert.equal(chain.length, 4, "export must read durable integrity via getAuditIntegrity");
    assert.deepEqual(
      chain.map((e) => e.integrity.sequence),
      [1, 2, 3, 4],
      "sequences are contiguous",
    );
    const verification = await verifyAuditIntegrity(chain, KEY);
    assert.equal(verification.valid, true, verification.breakDetail ?? "chain should verify");
    assert.equal(verification.eventsVerified, 4);
  });

  it("warns once for a durable adapter without appendToAuditChain, and still exports + verifies", async () => {
    const base = createMemoryStorage();
    // Durable integrity via the legacy write method, but NO atomic append.
    const durableNoAtomic: GovernanceStorage = {
      ...coreSurface(base),
      createAuditEventWithIntegrity: base.createAuditEventWithIntegrity,
      getChainHead: base.getChainHead,
      getAuditIntegrity: base.getAuditIntegrity,
      // intentionally omit: appendToAuditChain
    };

    const warnings: Error[] = [];
    const gov = createGovernance({
      storage: durableNoAtomic,
      integrityAudit: { signingKey: KEY },
      onAuditError: (e) => warnings.push(e as Error),
    });

    await writeN(gov, 3);

    const nonAtomicWarnings = warnings.filter(
      (w) => w instanceof Error && /appendToAuditChain/.test(w.message),
    );
    assert.equal(
      nonAtomicWarnings.length,
      1,
      "process-local fallback warns exactly once (not per write)",
    );
    assert.match(nonAtomicWarnings[0].message, /single writer/);

    const chain = await gov.integrityChain!.export();
    assert.equal(chain.length, 3, "durable path still persists + exports the chain");
    const verification = await verifyAuditIntegrity(chain, KEY);
    assert.equal(verification.valid, true, verification.breakDetail ?? "chain should verify");
  });
});
