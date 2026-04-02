import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMCPTrustRegistry } from "./mcp-trust";

describe("MCP Trust Registry", () => {
  it("validates trusted servers", () => {
    const trust = createMCPTrustRegistry({
      servers: [{ uri: "mcp://files.company.com", trust: "verified" }],
    });
    const result = trust.validate("mcp://files.company.com");
    assert.equal(result.allowed, true);
    assert.equal(result.trust, "verified");
  });

  it("returns default trust for unknown servers", () => {
    const trust = createMCPTrustRegistry({ defaultTrust: "untrusted" });
    const result = trust.validate("mcp://unknown.com");
    assert.equal(result.trust, "untrusted");
    assert.equal(result.allowed, true); // untrusted but not blocked by default
  });

  it("blocks unknown servers when blockUntrusted is true", () => {
    const trust = createMCPTrustRegistry({ defaultTrust: "untrusted", blockUntrusted: true });
    const result = trust.validate("mcp://unknown.com");
    assert.equal(result.allowed, false);
  });

  it("blocks explicitly blocked servers", () => {
    const trust = createMCPTrustRegistry({
      servers: [{ uri: "mcp://evil.com", trust: "blocked" }],
    });
    const result = trust.validate("mcp://evil.com");
    assert.equal(result.allowed, false);
    assert.equal(result.trust, "blocked");
  });

  it("normalizes URIs (case-insensitive, trailing slash)", () => {
    const trust = createMCPTrustRegistry({
      servers: [{ uri: "MCP://Files.Company.COM/", trust: "verified" }],
    });
    const result = trust.validate("mcp://files.company.com");
    assert.equal(result.allowed, true);
  });

  it("registers and removes servers", () => {
    const trust = createMCPTrustRegistry();
    trust.register({ uri: "mcp://new.com", trust: "trusted" });
    assert.equal(trust.validate("mcp://new.com").trust, "trusted");

    trust.remove("mcp://new.com");
    assert.equal(trust.validate("mcp://new.com").trust, "untrusted");
  });

  it("blocks a server", () => {
    const trust = createMCPTrustRegistry({
      servers: [{ uri: "mcp://suspect.com", trust: "known" }],
    });
    trust.block("mcp://suspect.com");
    assert.equal(trust.validate("mcp://suspect.com").allowed, false);
  });

  it("lists all servers", () => {
    const trust = createMCPTrustRegistry({
      servers: [
        { uri: "mcp://a.com", trust: "verified" },
        { uri: "mcp://b.com", trust: "untrusted" },
      ],
    });
    assert.equal(trust.list().length, 2);
  });

  it("reports stats by trust level", () => {
    const trust = createMCPTrustRegistry({
      servers: [
        { uri: "mcp://a.com", trust: "verified" },
        { uri: "mcp://b.com", trust: "verified" },
        { uri: "mcp://c.com", trust: "blocked" },
      ],
    });
    const stats = trust.stats();
    assert.equal(stats.verified, 2);
    assert.equal(stats.blocked, 1);
  });

  it("includes capabilities in validation", () => {
    const trust = createMCPTrustRegistry({
      servers: [{ uri: "mcp://files.com", trust: "trusted", capabilities: ["read", "write"] }],
    });
    const result = trust.validate("mcp://files.com");
    assert.deepEqual(result.capabilities, ["read", "write"]);
  });
});
