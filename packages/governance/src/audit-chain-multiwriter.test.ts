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
import { verifyAuditIntegrity } from "./audit-integrity-verify";

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
