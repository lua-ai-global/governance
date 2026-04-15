import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, mlInjectionGuard } from "./index";

describe("ml injection guard — async classifier wiring through sync enforce", () => {
  it("blocks when host-supplied ctx.mlInjectionScore exceeds threshold", async () => {
    const gov = createGovernance({ rules: [mlInjectionGuard({ threshold: 0.7 })] });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const decision = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      input: { prompt: "whatever" },
      mlInjectionScore: 0.9,
    });
    assert.equal(decision.blocked, true);
    assert.match(decision.reason.toLowerCase(), /ml classifier|injection/i);
  });

  it("allows when ctx.mlInjectionScore is below threshold", async () => {
    const gov = createGovernance({ rules: [mlInjectionGuard({ threshold: 0.7 })] });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const decision = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      input: { prompt: "whatever" },
      mlInjectionScore: 0.3,
    });
    assert.equal(decision.blocked, false);
  });

  it("is a no-op when host did not populate ctx.mlInjectionScore", async () => {
    const gov = createGovernance({ rules: [mlInjectionGuard({ threshold: 0.5 })] });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });
    const decision = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      input: { prompt: "whatever" },
    });
    assert.equal(decision.blocked, false);
  });

  it("requireCategory narrows the gate to a specific classifier category", async () => {
    const gov = createGovernance({
      rules: [mlInjectionGuard({ threshold: 0.5, requireCategory: "jailbreak" })],
    });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "t" });

    const noCategory = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      input: { prompt: "x" },
      mlInjectionScore: 0.9,
      mlInjectionCategories: ["other"],
    });
    assert.equal(noCategory.blocked, false, "should NOT block — wrong category");

    const matchingCategory = await gov.enforce({
      agentId: agent.id,
      action: "tool_call",
      input: { prompt: "x" },
      mlInjectionScore: 0.9,
      mlInjectionCategories: ["jailbreak"],
    });
    assert.equal(matchingCategory.blocked, true, "should block — category matched");
  });
});
