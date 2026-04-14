import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
} from "../index";
import {
  enforcePreprocess,
  enforcePostprocess,
  PREPROCESS_TOOL_NAME,
  POSTPROCESS_TOOL_NAME,
} from "./pre-post-enforce";
import {
  GovernanceBlockedError,
  GovernanceApprovalRequiredError,
} from "./outcome-handler";

async function registerTestAgent() {
  const gov = createGovernance({ rules: [] });
  const { id, level } = await gov.register({
    name: "pre-post-test",
    framework: "vercel-ai",
    owner: "test",
    hasAuditLog: true,
  });
  return { gov, agentId: id, agentLevel: level };
}

describe("pre-post-enforce — preprocess", () => {
  it("allow: returns original input unchanged", async () => {
    const { gov, agentId } = await registerTestAgent();
    const result = await enforcePreprocess(gov, "hello world", { agentId });
    assert.equal(result.text, "hello world");
    assert.equal(result.decision.blocked, false);
  });

  it("block: throws GovernanceBlockedError and fires onBlocked", async () => {
    const gov = createGovernance({
      rules: [inputBlocklist(["forbidden"], { reason: "blocked term" })],
    });
    const { id: agentId } = await gov.register({
      name: "t", framework: "vercel-ai", owner: "t",
    });

    let blockedToolName = "";
    await assert.rejects(
      () =>
        enforcePreprocess(gov, "please do forbidden stuff", {
          agentId,
          callbacks: {
            onBlocked: (_d, tn) => { blockedToolName = tn; },
          },
        }),
      GovernanceBlockedError,
    );
    assert.equal(blockedToolName, PREPROCESS_TOOL_NAME);
  });

  it("custom toolName override is honored in callbacks", async () => {
    const gov = createGovernance({ rules: [inputBlocklist(["nope"])] });
    const { id: agentId } = await gov.register({
      name: "t", framework: "vercel-ai", owner: "t",
    });
    let seen = "";
    await assert.rejects(
      () =>
        enforcePreprocess(gov, "nope", {
          agentId,
          toolName: "vercel.transformParams",
          callbacks: { onBlocked: (_d, tn) => { seen = tn; } },
        }),
    );
    assert.equal(seen, "vercel.transformParams");
  });
});

describe("pre-post-enforce — postprocess", () => {
  it("allow: returns original output unchanged", async () => {
    const { gov, agentId } = await registerTestAgent();
    const result = await enforcePostprocess(gov, "all good", { agentId });
    assert.equal(result.text, "all good");
  });

  it("mask: returns masked text and fires onMask", async () => {
    const gov = createGovernance({
      rules: [maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g", "SSN")],
    });
    const { id: agentId } = await gov.register({
      name: "t", framework: "vercel-ai", owner: "t",
    });

    let maskedText = "";
    const result = await enforcePostprocess(
      gov,
      "user ssn is 123-45-6789 keep private",
      {
        agentId,
        callbacks: {
          onMask: (_d, _tn, masked) => { maskedText = masked; },
        },
      },
    );

    assert.equal(result.decision.outcome, "mask");
    assert.notEqual(result.text, "user ssn is 123-45-6789 keep private");
    assert.ok(result.text.length > 0);
    assert.equal(maskedText, result.text);
  });

  it("sentinel tool name is POSTPROCESS_TOOL_NAME by default", async () => {
    const gov = createGovernance({
      rules: [maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g")],
    });
    const { id: agentId } = await gov.register({
      name: "t", framework: "vercel-ai", owner: "t",
    });
    let seen = "";
    await enforcePostprocess(gov, "ssn 123-45-6789", {
      agentId,
      callbacks: { onMask: (_d, tn) => { seen = tn; } },
    });
    assert.equal(seen, POSTPROCESS_TOOL_NAME);
  });
});

describe("pre-post-enforce — outcome propagation", () => {
  it("require_approval surfaces as GovernanceApprovalRequiredError", async () => {
    // Stub a governance instance that returns require_approval directly.
    const stubGov = {
      enforcePreprocess: async () => ({
        outcome: "require_approval" as const,
        blocked: true,
        reason: "needs review",
        ruleId: "r1",
        approvalId: "appr_123",
        approval: { pollUrl: "/approvals/appr_123" },
      }),
    } as unknown as Parameters<typeof enforcePreprocess>[0];

    await assert.rejects(
      () => enforcePreprocess(stubGov, "anything", { agentId: "a1" }),
      GovernanceApprovalRequiredError,
    );
  });

  it("warn: returns text unchanged and does not throw", async () => {
    const stubGov = {
      enforcePreprocess: async () => ({
        outcome: "warn" as const,
        blocked: false,
        reason: "suspicious but ok",
        ruleId: "r2",
      }),
    } as unknown as Parameters<typeof enforcePreprocess>[0];

    let warned = false;
    const result = await enforcePreprocess(stubGov, "some input", {
      agentId: "a1",
      callbacks: { onWarn: () => { warned = true; } },
    });

    assert.equal(result.text, "some input");
    assert.equal(warned, true);
  });
});
