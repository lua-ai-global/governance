import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPolicyEngine, requireSignedIdentity } from "../policy.js";
import type { EnforcementContext } from "../policy.js";

const base: EnforcementContext = {
  agentId: "luna",
  action: "tool_call",
  tool: "search",
};

function evalRule(
  rule: ReturnType<typeof requireSignedIdentity>,
  ctx: EnforcementContext,
) {
  const engine = createPolicyEngine({ rules: [rule] });
  return engine.evaluate(ctx);
}

describe("require_signed_identity condition", () => {
  it("blocks when host did not perform identity verification at all", () => {
    const r = evalRule(requireSignedIdentity(), base);
    assert.equal(r.blocked, true);
    assert.match(r.reason, /signed identity/i);
  });

  it("blocks when host explicitly marked verification as failed", () => {
    const r = evalRule(requireSignedIdentity(), {
      ...base,
      identityVerified: false,
      identityFailureReason: "no_cert",
    });
    assert.equal(r.blocked, true);
  });

  it("blocks when signature is verified but capability is not in cert", () => {
    const r = evalRule(requireSignedIdentity(), {
      ...base,
      identityVerified: true,
      identityCapabilityMatch: false,
    });
    assert.equal(r.blocked, true);
  });

  it("allows when signature is verified AND capability matches", () => {
    const r = evalRule(requireSignedIdentity(), {
      ...base,
      identityVerified: true,
      identityCapabilityMatch: true,
    });
    assert.equal(r.blocked, false);
  });

  it("allows verified identity even without capability match when capability binding is disabled", () => {
    const r = evalRule(requireSignedIdentity({ enforceCapabilityBinding: false }), {
      ...base,
      identityVerified: true,
      identityCapabilityMatch: false,
    });
    assert.equal(r.blocked, false);
  });

  it("still blocks unverified identity when capability binding is disabled", () => {
    const r = evalRule(requireSignedIdentity({ enforceCapabilityBinding: false }), {
      ...base,
      identityVerified: false,
    });
    assert.equal(r.blocked, true);
  });

  it("uses priority 950 — runs before most rules but below kill switch", () => {
    const rule = requireSignedIdentity();
    assert.equal(rule.priority, 950);
  });

  it("default reason mentions signed identity", () => {
    const rule = requireSignedIdentity();
    assert.match(rule.reason, /signed identity/i);
  });

  it("accepts a custom block reason", () => {
    const rule = requireSignedIdentity({ reason: "MUST sign your requests, dummy" });
    const r = evalRule(rule, base);
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "MUST sign your requests, dummy");
  });
});
