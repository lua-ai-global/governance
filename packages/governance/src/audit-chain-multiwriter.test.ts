/**
 * Multi-writer integrity audit chain tests.
 *
 * The chain state (sequence + previous-hash) is NOT process-local: it is
 * allocated atomically from the durable head on every write. Two separate
 * governance instances sharing ONE storage backend simulate two pods sharing
 * one database. Without atomic head-derivation each instance keeps its own
 * boot-time counter, both emit sequence 1, 2, 3…, and they either collide on
 * the unique (org, sequence) index (dropped events) or fork the hash chain.
 * With atomic head-derivation the writes interleave into a single contiguous,
 * standalone-verifiable chain.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance } from "./index";
import { createMemoryStorage } from "./storage";
import type { AuditEvent } from "./storage";
import { verifyAuditIntegrity } from "./audit-integrity-verify";
import { GENESIS_HASH, canonicalize, hmacSha256 } from "./audit-integrity";
import type { AuditIntegrity, IntegrityAuditEvent } from "./audit-integrity";

const KEY = "multi-writer-secret";

describe("integrity chain — multi-writer (shared storage, two instances)", () => {
  it("interleaves N concurrent writes from two pods into one contiguous, valid chain", async () => {
    // One shared backend = one database. Two instances = two pods.
    const storage = createMemoryStorage();
    const podA = createGovernance({ storage, integrityAudit: { signingKey: KEY } });
    const podB = createGovernance({ storage, integrityAudit: { signingKey: KEY } });

    const N = 40;
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      const pod = i % 2 === 0 ? podA : podB;
      writes.push(
        pod.enforce({ agentId: `a${i}`, organizationId: "orgX", action: "tool_call", tool: "t" }),
      );
    }
    await Promise.all(writes);

    const chain = await podA.integrityChain!.export({ organizationId: "orgX" });

    // Exactly N events — nothing dropped on a sequence collision.
    assert.equal(chain.length, N, `expected ${N} events, got ${chain.length} (dropped writes?)`);

    // Sequences are a contiguous 1..N with no duplicates and no gaps.
    const sequences = chain.map((e) => e.integrity.sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, Array.from({ length: N }, (_, i) => i + 1));

    // The single interleaved chain verifies standalone.
    const result = await verifyAuditIntegrity(chain, KEY);
    assert.equal(result.valid, true, result.breakDetail ?? "chain did not verify");

    // stats() reflects the TRUE durable head (N), not either pod's
    // process-local last-append sequence. Under interleaving each pod's own
    // cache lands below N, so a process-local stats() would under-report here.
    const statsA = await podA.integrityChain!.stats("orgX");
    const statsB = await podB.integrityChain!.stats("orgX");
    assert.equal(statsA.latestSequence, N, "podA stats must see the union head, not its own writes");
    assert.equal(statsB.latestSequence, N, "podB stats must see the union head, not its own writes");
    assert.equal(statsA.latestHash, chain[N - 1].integrity.hash, "latestHash is the true tip");
    assert.equal(statsA.latestHash, statsB.latestHash, "both pods agree on the durable head");
  });

  it("keeps each org's chain contiguous when two pods write to two orgs at once", async () => {
    const storage = createMemoryStorage();
    const podA = createGovernance({ storage, integrityAudit: { signingKey: KEY } });
    const podB = createGovernance({ storage, integrityAudit: { signingKey: KEY } });

    const perOrg = 15;
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < perOrg; i++) {
      writes.push(podA.enforce({ agentId: "a", organizationId: "orgA", action: "tool_call", tool: "t" }));
      writes.push(podB.enforce({ agentId: "b", organizationId: "orgA", action: "tool_call", tool: "t" }));
      writes.push(podA.enforce({ agentId: "c", organizationId: "orgB", action: "tool_call", tool: "t" }));
      writes.push(podB.enforce({ agentId: "d", organizationId: "orgB", action: "tool_call", tool: "t" }));
    }
    await Promise.all(writes);

    for (const org of ["orgA", "orgB"]) {
      const chain = await podA.integrityChain!.export({ organizationId: org });
      assert.equal(chain.length, perOrg * 2, `${org}: expected ${perOrg * 2} events`);
      const sequences = chain.map((e) => e.integrity.sequence).sort((a, b) => a - b);
      assert.deepEqual(sequences, Array.from({ length: perOrg * 2 }, (_, i) => i + 1), `${org}: sequences`);
      const result = await verifyAuditIntegrity(chain, KEY);
      assert.equal(result.valid, true, `${org}: ${result.breakDetail ?? "invalid"}`);
    }
  });
});

describe("integrity chain — wall-clock order disagrees with chain order", () => {
  // createdAt is stamped BEFORE the append lock allocates the sequence, so
  // under concurrent writers (lock-wait inversion) or cross-pod clock skew a
  // lower sequence can carry a LATER timestamp. The chain order is the
  // sequence — verification and export must not key on wall clock.
  async function chainedEvent(
    i: number,
    createdAt: string,
    prev: AuditIntegrity | null,
  ): Promise<IntegrityAuditEvent> {
    const event: AuditEvent = {
      id: `evt-${i}`,
      agentId: `a${i}`,
      eventType: "tool_call",
      outcome: "allow",
      severity: "info",
      organizationId: "orgSkew",
      createdAt,
    };
    const previousHash = prev?.hash ?? GENESIS_HASH;
    const sequence = (prev?.sequence ?? 0) + 1;
    const hash = await hmacSha256(KEY, canonicalize(event, previousHash, sequence));
    return { ...event, integrity: { hash, previousHash, sequence, signedAt: createdAt } };
  }

  it("verifies a chain whose createdAt order inverts its sequence order", async () => {
    // The seq-1 writer stamped its clock LAST: it entered writeAudit first
    // but won the lock ahead of two writers with earlier-running clocks.
    const e1 = await chainedEvent(1, "2026-07-15T10:00:00.150Z", null);
    const e2 = await chainedEvent(2, "2026-07-15T10:00:00.100Z", e1.integrity);
    const e3 = await chainedEvent(3, "2026-07-15T10:00:00.125Z", e2.integrity);

    const result = await verifyAuditIntegrity([e1, e2, e3], KEY);
    assert.equal(result.valid, true, result.breakDetail ?? "timestamp-skewed chain must verify");
  });

  it("export() orders by sequence, not createdAt", async () => {
    const storage = createMemoryStorage();
    const e1 = await chainedEvent(1, "2026-07-15T10:00:00.150Z", null);
    const e2 = await chainedEvent(2, "2026-07-15T10:00:00.100Z", e1.integrity);
    for (const { integrity, ...event } of [e1, e2]) {
      await storage.createAuditEventWithIntegrity!(event, integrity);
    }

    const gov = createGovernance({ storage, integrityAudit: { signingKey: KEY } });
    const chain = await gov.integrityChain!.export({ organizationId: "orgSkew" });
    assert.deepEqual(chain.map((e) => e.integrity.sequence), [1, 2]);
    const result = await verifyAuditIntegrity(chain, KEY);
    assert.equal(result.valid, true, result.breakDetail ?? "exported chain must verify");
  });
});
