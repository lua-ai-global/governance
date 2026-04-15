import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEd25519Identity, signAgentIdentity, verifyAgentIdentity } from "./agent-identity-ed25519";

describe("signAgentIdentity + verifyAgentIdentity (high-level wrappers)", () => {
  it("signs and verifies a valid token round-trip", async () => {
    const identity = createEd25519Identity();
    const keys = await identity.generateKeyPair();
    const token = await signAgentIdentity({ agentId: "sales-bot", keys, ttlSeconds: 3600 });

    const result = await verifyAgentIdentity(token);
    assert.equal(result.valid, true);
    assert.equal(result.agentId, "sales-bot");
  });

  it("embeds agent public key for self-verification", async () => {
    const identity = createEd25519Identity();
    const keys = await identity.generateKeyPair();
    const token = await signAgentIdentity({ agentId: "x", keys });

    assert.equal(token.payload.publicKeyHex, keys.publicKeyHex);
    assert.match(token.signature, /^[0-9a-f]+$/);
  });

  it("includes kid + capabilities when provided, sorted deterministically", async () => {
    const identity = createEd25519Identity();
    const keys = await identity.generateKeyPair();
    const token = await signAgentIdentity({
      agentId: "x",
      keys,
      kid: "v2",
      capabilities: ["zeta", "alpha", "omicron"],
    });
    assert.equal(token.payload.kid, "v2");
    assert.deepEqual(token.payload.capabilities, ["alpha", "omicron", "zeta"]);
  });

  it("rejects a token whose signature has been tampered with", async () => {
    const identity = createEd25519Identity();
    const keys = await identity.generateKeyPair();
    const token = await signAgentIdentity({ agentId: "x", keys });

    // Flip one byte of the signature (still hex-valid).
    const sig = token.signature;
    const firstByte = sig.slice(0, 2);
    const flipped = firstByte === "ff" ? "00" : "ff";
    const tampered = { ...token, signature: flipped + sig.slice(2) };

    const result = await verifyAgentIdentity(tampered);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "Invalid signature");
  });

  it("rejects a token whose payload has been modified", async () => {
    const identity = createEd25519Identity();
    const keys = await identity.generateKeyPair();
    const token = await signAgentIdentity({ agentId: "alice", keys });

    const tampered = { ...token, payload: { ...token.payload, agentId: "bob" } };
    const result = await verifyAgentIdentity(tampered);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "Invalid signature");
  });

  it("rejects an expired token", async () => {
    const identity = createEd25519Identity();
    const keys = await identity.generateKeyPair();
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const token = await signAgentIdentity({ agentId: "x", keys, ttlSeconds: 60, now: past });
    const result = await verifyAgentIdentity(token);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "Token expired");
  });

  it("rejects a token issued in the future beyond clock skew tolerance", async () => {
    const identity = createEd25519Identity();
    const keys = await identity.generateKeyPair();
    const future = Math.floor(Date.now() / 1000) + 10_000;
    const token = await signAgentIdentity({ agentId: "x", keys, ttlSeconds: 60, now: future });
    const result = await verifyAgentIdentity(token, { clockSkewSeconds: 60 });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "Token not yet valid");
  });

  it("enforces pinned public key when supplied", async () => {
    const identity = createEd25519Identity();
    const keysA = await identity.generateKeyPair();
    const keysB = await identity.generateKeyPair();
    const token = await signAgentIdentity({ agentId: "x", keys: keysA });

    const result = await verifyAgentIdentity(token, { pinnedPublicKeyHex: keysB.publicKeyHex });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "Public key does not match pinned key");

    const matched = await verifyAgentIdentity(token, { pinnedPublicKeyHex: keysA.publicKeyHex });
    assert.equal(matched.valid, true);
  });

  it("each signing produces a unique jti (prevents naive replay dedup collisions)", async () => {
    const identity = createEd25519Identity();
    const keys = await identity.generateKeyPair();
    const t1 = await signAgentIdentity({ agentId: "x", keys });
    const t2 = await signAgentIdentity({ agentId: "x", keys });
    assert.notEqual(t1.payload.jti, t2.payload.jti);
    assert.match(t1.payload.jti, /^[0-9a-f]{32}$/);
  });

  it("rejects malformed input", async () => {
    // @ts-expect-error - deliberately malformed
    const r1 = await verifyAgentIdentity(null);
    assert.equal(r1.valid, false);
    assert.equal(r1.reason, "Malformed token");

    // @ts-expect-error - deliberately malformed
    const r2 = await verifyAgentIdentity({ payload: {}, signature: 123 });
    assert.equal(r2.valid, false);
  });

  it("rejects tokens with invalid hex in publicKeyHex or signature", async () => {
    const r1 = await verifyAgentIdentity({
      payload: {
        agentId: "x",
        publicKeyHex: "not-hex",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: "abc",
      },
      signature: "also-not-hex",
    });
    assert.equal(r1.valid, false);
    assert.match(r1.reason ?? "", /encoding/i);
  });
});
