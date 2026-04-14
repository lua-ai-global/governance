import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
} from "../index";
import { createGovernanceMiddleware } from "./vercel-ai-middleware";
import type {
  VercelLanguageModelParams,
  VercelGenerateResult,
} from "./vercel-ai-middleware";
import { GovernanceBlockedError } from "./outcome-handler";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id, level } = await gov.register({
    name: "vercel-middleware-test",
    framework: "vercel-ai",
    owner: "test",
  });
  return { gov, agentId: id, agentLevel: level };
}

function makeParams(userText: string): VercelLanguageModelParams {
  return {
    prompt: [
      { role: "system", content: "you are helpful" },
      { role: "user", content: [{ type: "text", text: userText }] },
    ],
  };
}

describe("vercel-ai-middleware — transformParams (preprocess)", () => {
  it("allow: passes params through unchanged", async () => {
    const { gov, agentId } = await registerAgent();
    const mw = createGovernanceMiddleware(gov, { agentId });

    const params = makeParams("hello");
    const out = await mw.transformParams!({ type: "generate", params });
    assert.equal(out, params);
  });

  it("block: throws GovernanceBlockedError before the model runs", async () => {
    const { gov, agentId } = await registerAgent([
      inputBlocklist(["forbidden"], { reason: "blocked term" }),
    ]);
    const mw = createGovernanceMiddleware(gov, { agentId });

    await assert.rejects(
      () =>
        mw.transformParams!({
          type: "generate",
          params: makeParams("please do forbidden stuff"),
        }),
      GovernanceBlockedError,
    );
  });

  it("preprocess: false disables transformParams entirely", async () => {
    const { gov, agentId } = await registerAgent([
      inputBlocklist(["forbidden"]),
    ]);
    const mw = createGovernanceMiddleware(gov, {
      agentId,
      preprocess: false,
    });

    // transformParams should not exist → not called by SDK → not blocked.
    assert.equal(mw.transformParams, undefined);
  });

  it("handles string content (not just parts arrays)", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["bad"])]);
    const mw = createGovernanceMiddleware(gov, { agentId });

    await assert.rejects(
      () =>
        mw.transformParams!({
          type: "generate",
          params: {
            prompt: [{ role: "user", content: "something bad here" }],
          },
        }),
      GovernanceBlockedError,
    );
  });
});

describe("vercel-ai-middleware — wrapGenerate (postprocess)", () => {
  it("allow: returns result unchanged", async () => {
    const { gov, agentId } = await registerAgent();
    const mw = createGovernanceMiddleware(gov, { agentId });

    const original: VercelGenerateResult = { text: "clean response" };
    const out = await mw.wrapGenerate!({
      doGenerate: async () => original,
      params: makeParams("prompt"),
    });
    assert.equal(out.text, "clean response");
  });

  it("mask: replaces text with masked version", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g", "SSN"),
    ]);

    let maskedSeen = "";
    const mw = createGovernanceMiddleware(gov, {
      agentId,
      onMask: (_d, _tn, masked) => { maskedSeen = masked; },
    });

    const out = await mw.wrapGenerate!({
      doGenerate: async () => ({ text: "ssn is 123-45-6789 ok" }),
      params: makeParams("q"),
    });

    assert.notEqual(out.text, "ssn is 123-45-6789 ok");
    assert.equal(out.text, maskedSeen);
  });

  it("masks text inside content parts array (SDK 5.x shape)", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const mw = createGovernanceMiddleware(gov, { agentId });

    const original: VercelGenerateResult = {
      content: [{ type: "text", text: "ssn 123-45-6789 secret" }],
    };
    const out = await mw.wrapGenerate!({
      doGenerate: async () => original,
      params: makeParams("q"),
    });

    assert.ok(Array.isArray(out.content));
    const first = out.content![0];
    assert.notEqual(first.text, "ssn 123-45-6789 secret");
  });

  it("postprocess: false disables wrapGenerate entirely", async () => {
    const { gov, agentId } = await registerAgent();
    const mw = createGovernanceMiddleware(gov, {
      agentId,
      postprocess: false,
    });
    assert.equal(mw.wrapGenerate, undefined);
  });
});
