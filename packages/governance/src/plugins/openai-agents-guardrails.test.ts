import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
} from "../index";
import {
  createInputGuardrail,
  createOutputGuardrail,
} from "./openai-agents-guardrails";
import type { GuardrailOutputInfo } from "./openai-agents-guardrails";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "openai-agents-test", framework: "openai", owner: "t",
  });
  return { gov, agentId: id };
}

describe("openai-agents-guardrails — inputGuardrail", () => {
  it("allow: tripwireTriggered=false", async () => {
    const { gov, agentId } = await registerAgent();
    const g = createInputGuardrail(gov, { agentId });

    const result = await g.execute({ input: "hello world" });
    assert.equal(result.tripwireTriggered, false);
  });

  it("block: tripwireTriggered=true with decision in outputInfo", async () => {
    const { gov, agentId } = await registerAgent([
      inputBlocklist(["forbidden"], { reason: "bad term" }),
    ]);
    const g = createInputGuardrail(gov, { agentId });

    const result = await g.execute({ input: "do forbidden stuff" });
    assert.equal(result.tripwireTriggered, true);
    const info = result.outputInfo as GuardrailOutputInfo;
    assert.equal(info.stage, "preprocess");
    assert.equal(info.decision.blocked, true);
  });

  it("parses message-array input and extracts last user message", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["nope"])]);
    const g = createInputGuardrail(gov, { agentId });

    const result = await g.execute({
      input: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "input_text", text: "say nope please" }] },
      ],
    });
    assert.equal(result.tripwireTriggered, true);
  });

  it("empty input passes through without calling policy", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["anything"])]);
    const g = createInputGuardrail(gov, { agentId });

    const result = await g.execute({ input: "" });
    assert.equal(result.tripwireTriggered, false);
    assert.equal(result.outputInfo, null);
  });
});

describe("openai-agents-guardrails — outputGuardrail", () => {
  it("allow: tripwireTriggered=false", async () => {
    const { gov, agentId } = await registerAgent();
    const g = createOutputGuardrail(gov, { agentId });

    const result = await g.execute({ agentOutput: "clean response" });
    assert.equal(result.tripwireTriggered, false);
  });

  it("mask: tripwireTriggered=true with maskedText in outputInfo", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const g = createOutputGuardrail(gov, { agentId });

    const result = await g.execute({
      agentOutput: "ssn 123-45-6789 leaked",
    });
    assert.equal(result.tripwireTriggered, true);
    const info = result.outputInfo as GuardrailOutputInfo;
    assert.equal(info.stage, "postprocess");
    assert.ok(info.maskedText);
    assert.notEqual(info.maskedText, "ssn 123-45-6789 leaked");
  });

  it("extracts text from structured output", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const g = createOutputGuardrail(gov, { agentId });

    const result = await g.execute({
      agentOutput: { text: "ssn 123-45-6789 is bad" },
    });
    assert.equal(result.tripwireTriggered, true);
  });

  it("custom name is honored", async () => {
    const { gov, agentId } = await registerAgent();
    const g = createOutputGuardrail(gov, { agentId, name: "my-guard" });
    assert.equal(g.name, "my-guard");
  });
});
