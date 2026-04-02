import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPolicyEngine } from "../policy.js";
import type { EnforcementContext } from "../policy.js";
import {
  inputBlocklist, inputLength, inputPattern,
  networkAllowlist, scopeBoundary, costBudget, concurrentLimit,
  outputLength, outputPattern, sensitiveDataFilter,
} from "../policy-presets-extended.js";

function evalRule(rule: ReturnType<typeof inputBlocklist>, ctx: EnforcementContext) {
  const engine = createPolicyEngine({ rules: [rule] });
  return engine.evaluate(ctx);
}

const base: EnforcementContext = { agentId: "a", action: "tool_call" };

// ─── Preprocess Conditions ──────────────────────────────────────

describe("blocklist condition", () => {
  it("blocks input containing a blocked term", () => {
    const r = evalRule(inputBlocklist(["password", "secret"]), {
      ...base, input: { text: "my password is 123" },
    });
    assert.equal(r.blocked, true);
  });

  it("allows input without blocked terms", () => {
    const r = evalRule(inputBlocklist(["password"]), {
      ...base, input: { text: "hello world" },
    });
    assert.equal(r.blocked, false);
  });

  it("is case-insensitive by default", () => {
    const r = evalRule(inputBlocklist(["SECRET"]), {
      ...base, input: { text: "this is a secret" },
    });
    assert.equal(r.blocked, true);
  });

  it("respects caseSensitive option", () => {
    const r = evalRule(inputBlocklist(["SECRET"], { caseSensitive: true }), {
      ...base, input: { text: "this is a secret" },
    });
    assert.equal(r.blocked, false);
  });

  it("returns false when no input", () => {
    const r = evalRule(inputBlocklist(["test"]), base);
    assert.equal(r.blocked, false);
  });
});

describe("input_length condition", () => {
  it("blocks input exceeding maxChars", () => {
    const r = evalRule(inputLength(10), {
      ...base, input: { text: "x".repeat(50) },
    });
    assert.equal(r.blocked, true);
  });

  it("allows input within maxChars", () => {
    const r = evalRule(inputLength(1000), {
      ...base, input: { text: "short" },
    });
    assert.equal(r.blocked, false);
  });

  it("blocks input exceeding estimated maxTokens", () => {
    // 100 chars ≈ 25 tokens, maxTokens = 10
    const r = evalRule(inputLength(99999, 10), {
      ...base, input: { text: "x".repeat(100) },
    });
    assert.equal(r.blocked, true);
  });
});

describe("input_pattern condition", () => {
  it("blocks input matching pattern", () => {
    const r = evalRule(inputPattern("\\b\\d{3}-\\d{2}-\\d{4}\\b"), {
      ...base, input: { text: "SSN: 123-45-6789" },
    });
    assert.equal(r.blocked, true);
  });

  it("allows non-matching input", () => {
    const r = evalRule(inputPattern("\\bmalicious\\b"), {
      ...base, input: { text: "hello world" },
    });
    assert.equal(r.blocked, false);
  });

  it("supports regex flags", () => {
    const r = evalRule(inputPattern("SECRET", "i"), {
      ...base, input: { text: "this is a secret" },
    });
    assert.equal(r.blocked, true);
  });
});

// ─── Process Conditions ─────────────────────────────────────────

describe("network_allowlist condition", () => {
  it("blocks requests to non-allowed domains", () => {
    const r = evalRule(networkAllowlist(["api.example.com"]), {
      ...base, targetUrl: "https://evil.com/data",
    });
    assert.equal(r.blocked, true);
  });

  it("allows requests to allowed domains", () => {
    const r = evalRule(networkAllowlist(["api.example.com"]), {
      ...base, targetUrl: "https://api.example.com/v1/data",
    });
    assert.equal(r.blocked, false);
  });

  it("allows subdomains of allowed domains", () => {
    const r = evalRule(networkAllowlist(["example.com"]), {
      ...base, targetUrl: "https://api.example.com/v1",
    });
    assert.equal(r.blocked, false);
  });

  it("returns false when no targetUrl", () => {
    const r = evalRule(networkAllowlist(["example.com"]), base);
    assert.equal(r.blocked, false);
  });
});

describe("scope_boundary condition", () => {
  it("blocks paths in blockedPaths", () => {
    const r = evalRule(scopeBoundary({ blockedPaths: ["/etc/*", "/root/*"] }), {
      ...base, targetPath: "/etc/passwd",
    });
    assert.equal(r.blocked, true);
  });

  it("allows paths not in blockedPaths", () => {
    const r = evalRule(scopeBoundary({ blockedPaths: ["/etc/*"] }), {
      ...base, targetPath: "/data/report.csv",
    });
    assert.equal(r.blocked, false);
  });

  it("blocks paths outside allowedPaths", () => {
    const r = evalRule(scopeBoundary({ allowedPaths: ["/data/*", "/tmp/*"] }), {
      ...base, targetPath: "/etc/passwd",
    });
    assert.equal(r.blocked, true);
  });

  it("allows paths inside allowedPaths", () => {
    const r = evalRule(scopeBoundary({ allowedPaths: ["/data/*"] }), {
      ...base, targetPath: "/data/report.csv",
    });
    assert.equal(r.blocked, false);
  });

  it("returns false when no targetPath", () => {
    const r = evalRule(scopeBoundary({ blockedPaths: ["/etc/*"] }), base);
    assert.equal(r.blocked, false);
  });

  it("blocks path traversal via ../ that escapes allowedPaths", () => {
    const r = evalRule(scopeBoundary({ allowedPaths: ["/home/user/*"] }), {
      ...base, targetPath: "/home/user/../../etc/passwd",
    });
    assert.equal(r.blocked, true);
  });

  it("blocks path traversal into blockedPaths via ../", () => {
    const r = evalRule(scopeBoundary({ blockedPaths: ["/etc/*"] }), {
      ...base, targetPath: "/home/user/../../etc/passwd",
    });
    assert.equal(r.blocked, true);
  });

  it("normalizes . segments in paths", () => {
    const r = evalRule(scopeBoundary({ allowedPaths: ["/data/*"] }), {
      ...base, targetPath: "/data/./report.csv",
    });
    assert.equal(r.blocked, false);
  });
});

describe("cost_budget condition", () => {
  it("blocks when session cost exceeds budget", () => {
    const r = evalRule(costBudget(100), { ...base, sessionCost: 150 });
    assert.equal(r.blocked, true);
  });

  it("allows when session cost is within budget", () => {
    const r = evalRule(costBudget(100), { ...base, sessionCost: 50 });
    assert.equal(r.blocked, false);
  });

  it("allows when no sessionCost provided (defaults to 0)", () => {
    const r = evalRule(costBudget(100), base);
    assert.equal(r.blocked, false);
  });
});

describe("concurrent_limit condition", () => {
  it("blocks when concurrent count exceeds limit", () => {
    const r = evalRule(concurrentLimit(5), { ...base, concurrentCount: 10 });
    assert.equal(r.blocked, true);
  });

  it("allows when within limit", () => {
    const r = evalRule(concurrentLimit(5), { ...base, concurrentCount: 3 });
    assert.equal(r.blocked, false);
  });
});

// ─── Postprocess Conditions ─────────────────────────────────────

describe("output_length condition", () => {
  it("triggers warn when output exceeds maxChars", () => {
    const r = evalRule(outputLength(50), {
      ...base, outputText: "x".repeat(100),
    });
    // outputLength defaults to "warn" outcome
    assert.equal(r.outcome, "warn");
    assert.equal(r.blocked, false);
  });

  it("allows output within limit", () => {
    const r = evalRule(outputLength(200), {
      ...base, outputText: "short output",
    });
    assert.equal(r.outcome, "allow");
  });

  it("uses outputTokenCount when provided", () => {
    const r = evalRule(outputLength(99999, 10), {
      ...base, outputText: "some text", outputTokenCount: 50,
    });
    assert.equal(r.outcome, "warn");
  });
});

describe("output_pattern condition", () => {
  it("blocks output matching pattern", () => {
    const r = evalRule(outputPattern("sk-[a-zA-Z0-9]{20,}"), {
      ...base, outputText: "Your key is sk-abcdefghijklmnopqrstuvwxyz",
    });
    assert.equal(r.blocked, true);
  });

  it("allows output not matching", () => {
    const r = evalRule(outputPattern("sk-[a-zA-Z0-9]{20,}"), {
      ...base, outputText: "No secrets here",
    });
    assert.equal(r.blocked, false);
  });
});

describe("sensitive_data_filter condition", () => {
  it("detects AWS access keys", () => {
    const r = evalRule(sensitiveDataFilter(), {
      ...base, outputText: "Key: AKIAIOSFODNN7EXAMPLE",
    });
    assert.equal(r.blocked, true);
  });

  it("detects GitHub PATs", () => {
    const r = evalRule(sensitiveDataFilter(), {
      ...base, outputText: "Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    });
    assert.equal(r.blocked, true);
  });

  it("detects JWTs", () => {
    const r = evalRule(sensitiveDataFilter(), {
      ...base,
      outputText: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    });
    assert.equal(r.blocked, true);
  });

  it("detects private keys", () => {
    const r = evalRule(sensitiveDataFilter(), {
      ...base, outputText: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...",
    });
    assert.equal(r.blocked, true);
  });

  it("detects connection strings", () => {
    const r = evalRule(sensitiveDataFilter(), {
      ...base, outputText: "postgres://user:pass@host:5432/db",
    });
    assert.equal(r.blocked, true);
  });

  it("allows clean output", () => {
    const r = evalRule(sensitiveDataFilter(), {
      ...base, outputText: "The weather today is sunny.",
    });
    assert.equal(r.blocked, false);
  });

  it("filters by pattern IDs when specified", () => {
    const r = evalRule(sensitiveDataFilter(["aws_key"]), {
      ...base, outputText: "Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    });
    // GitHub PAT should NOT be caught when only aws_key is specified
    assert.equal(r.blocked, false);
  });

  it("returns false when no output", () => {
    const r = evalRule(sensitiveDataFilter(), base);
    assert.equal(r.blocked, false);
  });
});
