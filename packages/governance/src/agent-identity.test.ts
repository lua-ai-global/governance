import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgentIdentity } from "./agent-identity";

describe("Agent Identity", () => {
  const signingKey = "test-signing-key-2026";
  const agent = { id: "agent-1", name: "sales-bot", owner: "team-a", version: "1.2.0" };

  it("issues a token with signature and fingerprint", async () => {
    const identity = createAgentIdentity(signingKey);
    const token = await identity.issueToken(agent);

    assert.ok(token.signature);
    assert.equal(token.signature.length, 64); // SHA-256 hex
    assert.equal(token.agentId, "agent-1");
    assert.ok(token.issuedAt);
    assert.equal(token.fingerprint, token.signature.slice(0, 16));
    assert.equal(token.expiresAt, undefined); // no TTL configured
  });

  it("verifies a valid token", async () => {
    const identity = createAgentIdentity(signingKey);
    const token = await identity.issueToken(agent);
    const result = await identity.verifyToken(token, agent);

    assert.equal(result.valid, true);
    assert.equal(result.reason, undefined);
  });

  it("rejects token with mismatched agent ID", async () => {
    const identity = createAgentIdentity(signingKey);
    const token = await identity.issueToken(agent);
    const result = await identity.verifyToken(token, { ...agent, id: "different-agent" });

    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("agent ID"));
  });

  it("rejects token when agent identity is tampered with", async () => {
    const identity = createAgentIdentity(signingKey);
    const token = await identity.issueToken(agent);
    const result = await identity.verifyToken(token, { ...agent, name: "tampered-name" });

    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("Signature mismatch"));
  });

  it("rejects expired token", async () => {
    const identity = createAgentIdentity(signingKey, { tokenTtlMs: 1 }); // 1ms TTL
    const token = await identity.issueToken(agent);

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await identity.verifyToken(token, agent);
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("expired"));
  });

  it("includes expiresAt when TTL is configured", async () => {
    const identity = createAgentIdentity(signingKey, { tokenTtlMs: 3600_000 });
    const token = await identity.issueToken(agent);
    assert.ok(token.expiresAt);
  });

  it("generates deterministic fingerprints", async () => {
    const identity = createAgentIdentity(signingKey);
    const fp1 = await identity.getFingerprint(agent);
    const fp2 = await identity.getFingerprint(agent);

    assert.equal(fp1, fp2);
    assert.equal(fp1.length, 16);
  });

  it("generates different fingerprints for different agents", async () => {
    const identity = createAgentIdentity(signingKey);
    const fp1 = await identity.getFingerprint(agent);
    const fp2 = await identity.getFingerprint({ ...agent, id: "agent-2", name: "other-bot" });

    assert.notEqual(fp1, fp2);
  });

  it("generates different signatures with different signing keys", async () => {
    const id1 = createAgentIdentity("key-a");
    const id2 = createAgentIdentity("key-b");
    const fp1 = await id1.getFingerprint(agent);
    const fp2 = await id2.getFingerprint(agent);

    assert.notEqual(fp1, fp2);
  });

  it("throws on empty signing key", () => {
    assert.throws(() => createAgentIdentity(""), /Signing key is required/);
  });

  it("handles agents with minimal fields", async () => {
    const identity = createAgentIdentity(signingKey);
    const minimal = { id: "min", name: "minimal" };
    const token = await identity.issueToken(minimal);
    const result = await identity.verifyToken(token, minimal);
    assert.equal(result.valid, true);
  });
});
