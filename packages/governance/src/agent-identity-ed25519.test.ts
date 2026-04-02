import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEd25519Identity } from "./agent-identity-ed25519";

describe("Ed25519 Agent Identity", () => {
  const identity = createEd25519Identity();

  it("generates a key pair with hex-encoded public key", async () => {
    const kp = await identity.generateKeyPair();
    assert.ok(kp.publicKey);
    assert.ok(kp.privateKey);
    assert.equal(kp.publicKeyHex.length, 64); // 32 bytes hex
  });

  it("generates unique key pairs", async () => {
    const kp1 = await identity.generateKeyPair();
    const kp2 = await identity.generateKeyPair();
    assert.notEqual(kp1.publicKeyHex, kp2.publicKeyHex);
  });

  it("signs and verifies an action", async () => {
    const kp = await identity.generateKeyPair();
    const data = { action: "tool_call", tool: "search", agentId: "bot-1" };
    const sig = await identity.signAction(kp.privateKey, data);
    assert.ok(sig.length > 0);

    const valid = await identity.verifyAction(kp.publicKey, data, sig);
    assert.equal(valid, true);
  });

  it("rejects tampered action data", async () => {
    const kp = await identity.generateKeyPair();
    const data = { action: "tool_call", tool: "search" };
    const sig = await identity.signAction(kp.privateKey, data);

    const valid = await identity.verifyAction(kp.publicKey, { action: "tool_call", tool: "delete" }, sig);
    assert.equal(valid, false);
  });

  it("rejects verification with wrong public key", async () => {
    const kp1 = await identity.generateKeyPair();
    const kp2 = await identity.generateKeyPair();
    const data = { action: "test" };
    const sig = await identity.signAction(kp1.privateKey, data);

    const valid = await identity.verifyAction(kp2.publicKey, data, sig);
    assert.equal(valid, false);
  });

  it("creates a self-signed certificate", async () => {
    const kp = await identity.generateKeyPair();
    const cert = await identity.createCertificate(kp.privateKey, {
      agentId: "bot-1", name: "sales-bot", capabilities: ["search", "email"],
    });

    assert.equal(cert.agentId, "bot-1");
    assert.equal(cert.name, "sales-bot");
    assert.deepEqual(cert.capabilities, ["email", "search"]); // sorted
    assert.equal(cert.delegationDepth, 0);
    assert.ok(cert.signature);
    assert.ok(cert.issuedAt);
    assert.ok(cert.expiresAt);
  });

  it("verifies a valid certificate", async () => {
    const kp = await identity.generateKeyPair();
    const cert = await identity.createCertificate(kp.privateKey, {
      agentId: "bot-1", name: "test", capabilities: ["read"],
    });
    const result = await identity.verifyCertificate(cert);
    assert.equal(result.valid, true);
  });

  it("rejects a tampered certificate", async () => {
    const kp = await identity.generateKeyPair();
    const cert = await identity.createCertificate(kp.privateKey, {
      agentId: "bot-1", name: "test", capabilities: ["read"],
    });
    cert.name = "tampered";
    const result = await identity.verifyCertificate(cert);
    assert.equal(result.valid, false);
  });

  it("delegates identity with narrowed capabilities", async () => {
    const kp = await identity.generateKeyPair();
    const parentCert = await identity.createCertificate(kp.privateKey, {
      agentId: "parent", name: "parent-bot", capabilities: ["read", "write", "delete"],
    });

    const delegated = await identity.delegate(kp.privateKey, parentCert, {
      agentId: "child", name: "child-bot", capabilities: ["read"],
    });

    assert.equal(delegated.certificate.agentId, "child");
    assert.deepEqual(delegated.certificate.capabilities, ["read"]);
    assert.equal(delegated.certificate.delegationDepth, 1);
    assert.equal(delegated.certificate.issuer, "parent");
    assert.ok(delegated.keyPair.publicKeyHex);
  });

  it("rejects delegation with capabilities not held by parent", async () => {
    const kp = await identity.generateKeyPair();
    const parentCert = await identity.createCertificate(kp.privateKey, {
      agentId: "parent", name: "parent", capabilities: ["read"],
    });

    await assert.rejects(
      () => identity.delegate(kp.privateKey, parentCert, {
        agentId: "child", name: "child", capabilities: ["read", "admin"],
      }),
      /Cannot delegate capabilities not held by parent: admin/,
    );
  });

  it("rejects delegation exceeding max depth", async () => {
    const shallow = createEd25519Identity({ maxDelegationDepth: 1 });
    const kp = await shallow.generateKeyPair();
    const cert = await shallow.createCertificate(kp.privateKey, {
      agentId: "p", name: "p", capabilities: ["read"],
    });

    const d1 = await shallow.delegate(kp.privateKey, cert, {
      agentId: "c1", name: "c1", capabilities: ["read"],
    });

    await assert.rejects(
      () => shallow.delegate(kp.privateKey, d1.certificate, {
        agentId: "c2", name: "c2", capabilities: ["read"],
      }),
      /Delegation depth 2 exceeds maximum 1/,
    );
  });

  it("rejects expired certificate", async () => {
    const expired = createEd25519Identity({ certificateTtlMs: 1 });
    const kp = await expired.generateKeyPair();
    const cert = await expired.createCertificate(kp.privateKey, {
      agentId: "bot", name: "bot", capabilities: [],
    });

    await new Promise((r) => setTimeout(r, 5));

    const result = await expired.verifyCertificate(cert);
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("expired"));
  });

  it("imports public key from hex and verifies", async () => {
    const kp = await identity.generateKeyPair();
    const data = { test: "data" };
    const sig = await identity.signAction(kp.privateKey, data);

    const importedKey = await identity.importPublicKey(kp.publicKeyHex);
    const valid = await identity.verifyAction(importedKey, data, sig);
    assert.equal(valid, true);
  });
});
