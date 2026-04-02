import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSandbox, SANDBOX_LEVELS } from "./sandbox";
import { createGovernance } from "./index";

describe("Execution Sandboxing", () => {
  it("defines 4 sandbox levels", () => {
    assert.equal(SANDBOX_LEVELS.length, 4);
    assert.equal(SANDBOX_LEVELS[0].label, "Unrestricted");
    assert.equal(SANDBOX_LEVELS[1].label, "Read-Only");
    assert.equal(SANDBOX_LEVELS[2].label, "Limited Write");
    assert.equal(SANDBOX_LEVELS[3].label, "Full Sandboxed");
  });

  it("level 0 allows everything", () => {
    const sandbox = createSandbox({ level: 0 });
    assert.equal(sandbox.levelRule.enabled, false); // unrestricted = disabled rule
  });

  it("level 1 blocks writes and mutations", async () => {
    const gov = createGovernance({ rules: [createSandbox({ level: 1 }).levelRule] });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "team" });

    const read = await gov.enforce({ agentId: agent.id, action: "data_access" });
    assert.equal(read.blocked, false);

    const write = await gov.enforce({ agentId: agent.id, action: "file_write" });
    assert.equal(write.blocked, true);

    const payment = await gov.enforce({ agentId: agent.id, action: "payment" });
    assert.equal(payment.blocked, true);
  });

  it("level 2 allows file_write but blocks external_request", async () => {
    const gov = createGovernance({ rules: [createSandbox({ level: 2 }).levelRule] });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "team" });

    const write = await gov.enforce({ agentId: agent.id, action: "file_write" });
    assert.equal(write.blocked, false);

    const external = await gov.enforce({ agentId: agent.id, action: "external_request" });
    assert.equal(external.blocked, true);
  });

  it("tracks and enforces tool call quota", () => {
    const sandbox = createSandbox({ level: 1, quotas: { maxToolCalls: 3 } });
    assert.equal(sandbox.quotaExceeded(), false);

    sandbox.recordToolCall();
    sandbox.recordToolCall();
    assert.equal(sandbox.quotaExceeded(), false);

    sandbox.recordToolCall();
    assert.equal(sandbox.quotaExceeded(), true);
  });

  it("tracks token quota", () => {
    const sandbox = createSandbox({ level: 1, quotas: { maxTokens: 1000 } });
    sandbox.recordTokens(500);
    assert.equal(sandbox.quotaExceeded(), false);
    sandbox.recordTokens(600);
    assert.equal(sandbox.quotaExceeded(), true);
  });

  it("tracks cost quota", () => {
    const sandbox = createSandbox({ level: 1, quotas: { maxCostUsd: 1.0 } });
    sandbox.recordCost(0.50);
    assert.equal(sandbox.quotaExceeded(), false);
    sandbox.recordCost(0.60);
    assert.equal(sandbox.quotaExceeded(), true);
  });

  it("resets session state", () => {
    const sandbox = createSandbox({ level: 1, quotas: { maxToolCalls: 2 } });
    sandbox.recordToolCall();
    sandbox.recordToolCall();
    assert.equal(sandbox.quotaExceeded(), true);

    sandbox.reset();
    assert.equal(sandbox.quotaExceeded(), false);
    assert.equal(sandbox.getState().toolCalls, 0);
  });

  it("exposes current state", () => {
    const sandbox = createSandbox({ level: 2 });
    sandbox.recordToolCall();
    sandbox.recordTokens(100);
    sandbox.recordCost(0.01);

    const state = sandbox.getState();
    assert.equal(state.toolCalls, 1);
    assert.equal(state.tokensUsed, 100);
    assert.equal(state.costUsd, 0.01);
    assert.equal(state.level.level, 2);
  });

  it("quota rule blocks when quota exceeded", async () => {
    const sandbox = createSandbox({ level: 1, quotas: { maxToolCalls: 1 } });
    const gov = createGovernance({ rules: [sandbox.quotaRule] });
    const agent = await gov.register({ name: "bot", framework: "mastra", owner: "team" });

    sandbox.recordToolCall(); // hits quota

    const result = await gov.enforce({ agentId: agent.id, action: "tool_call" });
    assert.equal(result.blocked, true);
    assert.ok(result.reason.includes("quota"));
  });
});
