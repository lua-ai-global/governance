/**
 * Per-org integrity audit chain tests.
 *
 * Chains are scoped per organization: each org gets an independent HMAC chain
 * with its own head and its own 1..N sequence. This means:
 *   - one org's events never interleave into another org's chain
 *   - a single org's exported slice is contiguous and verifies standalone
 *   - relabelling an event into a different org breaks its hash (org is bound
 *     into the canonical form)
 *   - events with NO organizationId share one org-less chain, byte-for-byte
 *     compatible with chains written before per-org scoping existed
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance } from "./index";
import { verifyAuditIntegrity } from "./audit-integrity-verify";

const KEY = "per-org-chain-secret";

describe("integrity chain — per-org scoping", () => {
  it("gives each org an independent, contiguous, standalone-verifiable chain", async () => {
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });

    // 3 events for org A, 2 for org B, interleaved in time.
    await gov.enforce({ agentId: "a1", organizationId: "orgA", action: "tool_call", tool: "t" });
    await gov.enforce({ agentId: "b1", organizationId: "orgB", action: "tool_call", tool: "t" });
    await gov.enforce({ agentId: "a1", organizationId: "orgA", action: "tool_call", tool: "t" });
    await gov.enforce({ agentId: "b1", organizationId: "orgB", action: "tool_call", tool: "t" });
    await gov.enforce({ agentId: "a1", organizationId: "orgA", action: "tool_call", tool: "t" });

    const chainA = await gov.integrityChain!.export({ organizationId: "orgA" });
    const chainB = await gov.integrityChain!.export({ organizationId: "orgB" });

    // Each org's slice carries only its own events, with contiguous sequences.
    assert.equal(chainA.length, 3);
    assert.equal(chainB.length, 2);
    assert.deepEqual(chainA.map((e) => e.integrity.sequence), [1, 2, 3]);
    assert.deepEqual(chainB.map((e) => e.integrity.sequence), [1, 2]);
    assert.ok(chainA.every((e) => e.organizationId === "orgA"));
    assert.ok(chainB.every((e) => e.organizationId === "orgB"));

    // Each slice verifies cleanly on its own.
    const rA = await verifyAuditIntegrity(chainA, KEY);
    const rB = await verifyAuditIntegrity(chainB, KEY);
    assert.equal(rA.valid, true, rA.breakDetail ?? "");
    assert.equal(rB.valid, true, rB.breakDetail ?? "");

    // Heads are tracked per-org.
    assert.equal((await gov.integrityChain!.stats("orgA")).latestSequence, 3);
    assert.equal((await gov.integrityChain!.stats("orgB")).latestSequence, 2);
  });

  it("binds organizationId into the hash — relabelling into another org breaks verification", async () => {
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });
    await gov.enforce({ agentId: "a1", organizationId: "orgA", action: "tool_call", tool: "t" });
    const [event] = await gov.integrityChain!.export({ organizationId: "orgA" });

    // Untampered verifies.
    assert.equal((await verifyAuditIntegrity([event], KEY)).valid, true);

    // Move the event into another org without re-signing → hash no longer matches.
    const moved = { ...event, organizationId: "orgB" };
    const res = await verifyAuditIntegrity([moved], KEY);
    assert.equal(res.valid, false);
  });

  it("resolves org from metadata.organizationId when the field is omitted", async () => {
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });
    await gov.enforce({ agentId: "a1", action: "tool_call", tool: "t", metadata: { organizationId: "orgMeta" } });

    const chain = await gov.integrityChain!.export({ organizationId: "orgMeta" });
    assert.equal(chain.length, 1);
    assert.equal(chain[0].organizationId, "orgMeta");
    assert.equal((await gov.integrityChain!.stats("orgMeta")).latestSequence, 1);
  });

  it("keeps the org-less chain independent from org chains", async () => {
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });
    await gov.audit.log({ agentId: "x", eventType: "custom", outcome: "success", severity: "info" });
    await gov.enforce({ agentId: "a1", organizationId: "orgA", action: "tool_call", tool: "t" });
    await gov.audit.log({ agentId: "x", eventType: "custom", outcome: "success", severity: "info" });

    // org-less chain has its own contiguous sequence (2), unaffected by orgA.
    const orgless = await gov.integrityChain!.export({});
    const orglessOnly = orgless.filter((e) => e.organizationId == null);
    assert.deepEqual(orglessOnly.map((e) => e.integrity.sequence), [1, 2]);
    assert.equal((await gov.integrityChain!.stats()).latestSequence, 2);
    assert.equal((await gov.integrityChain!.stats("orgA")).latestSequence, 1);
  });

  it("register() stamps the org onto the agent record and the agent_registered event", async () => {
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });
    const { id } = await gov.register({ name: "alpha", framework: "mastra", owner: "t", organizationId: "orgA" });

    const stored = await gov.storage.getAgent(id);
    assert.equal(stored?.organizationId, "orgA");

    const chainA = await gov.integrityChain!.export({ organizationId: "orgA" });
    assert.equal(chainA.length, 1);
    assert.equal(chainA[0].eventType, "agent_registered");
    assert.equal((await verifyAuditIntegrity(chainA, KEY)).valid, true);
  });

  it("recordOutcome() lands on the agent's org chain", async () => {
    const gov = createGovernance({ integrityAudit: { signingKey: KEY } });
    await gov.recordOutcome({ agentId: "a1", organizationId: "orgA", action: "tool_call", success: true });
    const chainA = await gov.integrityChain!.export({ organizationId: "orgA" });
    assert.equal(chainA.length, 1);
    assert.equal(chainA[0].eventType, "action_outcome");
  });
});
