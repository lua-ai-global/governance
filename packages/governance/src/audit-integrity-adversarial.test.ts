import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance } from "./index";
import { createIntegrityAudit, verifyAuditIntegrity, constantTimeEqualHex } from "./audit-integrity";

const KEY = "test-signing-key-do-not-use-in-prod";

async function buildChain(count = 5) {
  const gov = createGovernance({});
  const integrity = createIntegrityAudit(gov, { signingKey: KEY });
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push(
      await integrity.log({
        agentId: `bot-${i}`,
        eventType: "tool_call",
        outcome: "allow",
        severity: "info",
        detail: { index: i },
      }),
    );
  }
  return { gov, integrity, entries };
}

describe("audit integrity — adversarial scenarios", () => {
  it("accepts a clean chain (baseline)", async () => {
    const { entries } = await buildChain(5);
    const result = await verifyAuditIntegrity(entries, KEY);
    assert.equal(result.valid, true);
    assert.equal(result.eventsVerified, 5);
  });

  it("detects edit: mutated event content breaks hash check", async () => {
    const { entries } = await buildChain(5);
    // Deep-clone first so we don't mutate the source.
    const tampered = entries.map((e) => ({ ...e, integrity: { ...e.integrity } }));
    // Edit the detail payload of the 3rd event.
    tampered[2] = { ...tampered[2], detail: { index: 999 } };
    const result = await verifyAuditIntegrity(tampered, KEY);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 2);
    assert.match(result.breakDetail ?? "", /modified/);
  });

  it("detects deletion: removing a middle entry breaks sequence + previousHash", async () => {
    const { entries } = await buildChain(5);
    const shortened = [entries[0], entries[1], entries[3], entries[4]];
    const result = await verifyAuditIntegrity(shortened, KEY);
    assert.equal(result.valid, false);
    // Position 2 is where entry 4 now sits but its sequence is 4, expected 3.
    assert.equal(result.brokenAt, 2);
  });

  it("detects reorder attempt: renumbering sequences to mask a swap breaks the hash", async () => {
    // The verifier sorts by (createdAt, sequence) before checking, so a raw
    // array reorder re-sorts back to canonical order. An attacker wanting to
    // actually reorder the chain would have to edit the sequence numbers and
    // previousHash fields — doing so breaks the signed hash. This test
    // exercises that attack path.
    const { entries } = await buildChain(5);
    const attackerOrder = [
      entries[0],
      entries[1],
      {
        ...entries[3],
        createdAt: entries[2].createdAt,
        integrity: { ...entries[3].integrity, sequence: 3 },
      },
      {
        ...entries[2],
        createdAt: entries[3].createdAt,
        integrity: { ...entries[2].integrity, sequence: 4 },
      },
      entries[4],
    ];
    const result = await verifyAuditIntegrity(attackerOrder, KEY);
    assert.equal(result.valid, false);
    // First broken hash is where the attacker renumbered — content-vs-sequence mismatch.
    assert.ok(result.brokenAt !== null && result.brokenAt >= 2);
  });

  it("detects truncation: dropping the last entry still verifies the prefix, but the prefix is shorter", async () => {
    const { entries } = await buildChain(5);
    const truncated = entries.slice(0, 4);
    // A truncated chain IS still valid on its own — that's the honest
    // limitation of plain HMAC chains (no external anchor = can't distinguish
    // "5 events truncated to 4" from "chain was always 4 events long").
    // Document this by asserting it and explaining why: if you need rollback
    // detection you need to publish a checkpoint externally.
    const result = await verifyAuditIntegrity(truncated, KEY);
    assert.equal(result.valid, true, "truncated prefix still verifies — this is expected without an external anchor");
    assert.equal(result.eventsVerified, 4);
  });

  it("detects forgery: appending an entry signed with a different secret fails", async () => {
    const { entries } = await buildChain(3);
    // Make a fake entry pretending to be entry 4.
    const fake = {
      ...entries[2],
      id: "forged-id",
      detail: { forged: true },
      integrity: {
        ...entries[2].integrity,
        sequence: 4,
        previousHash: entries[2].integrity.hash,
        hash: "00".repeat(32), // arbitrary — attacker doesn't know the secret
      },
    };
    const result = await verifyAuditIntegrity([...entries, fake], KEY);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 3);
  });

  it("detects wrong secret: a full-chain re-verification with the wrong key fails at entry 0", async () => {
    const { entries } = await buildChain(3);
    const result = await verifyAuditIntegrity(entries, "not-the-real-key");
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 0);
    assert.match(result.breakDetail ?? "", /modified|hash/i);
  });
});

describe("constantTimeEqualHex", () => {
  it("returns true for equal strings", () => {
    assert.equal(constantTimeEqualHex("abc123", "abc123"), true);
  });
  it("returns false for different strings of same length", () => {
    assert.equal(constantTimeEqualHex("abc123", "abc124"), false);
  });
  it("returns false for strings of different length", () => {
    assert.equal(constantTimeEqualHex("abc", "abcd"), false);
  });
  it("returns false for non-strings", () => {
    // @ts-expect-error - deliberately wrong type
    assert.equal(constantTimeEqualHex(null, "abc"), false);
  });
  it("walks the full buffer regardless of early-mismatch position", () => {
    // We can't measure time reliably in a test, but we can at least assert
    // correctness for a pathological "differs at position 0" case.
    const a = "f" + "0".repeat(63);
    const b = "0".repeat(64);
    assert.equal(constantTimeEqualHex(a, b), false);
  });
});
