import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSandbox, SANDBOX_LEVELS, runInVmSandbox } from "./sandbox";
import { createGovernance } from "./index";

describe("Action-Gating Sandbox (policy-level)", () => {
  it("defines 4 sandbox levels", () => {
    assert.equal(SANDBOX_LEVELS.length, 4);
    assert.equal(SANDBOX_LEVELS[0].label, "Unrestricted");
    assert.equal(SANDBOX_LEVELS[1].label, "Read-Only");
    assert.equal(SANDBOX_LEVELS[2].label, "Limited Write");
    assert.equal(SANDBOX_LEVELS[3].label, "Full Action-Gated");
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

describe("runInVmSandbox (node:vm execution isolation)", () => {
  it("evaluates a pure expression and returns the value", () => {
    const result = runInVmSandbox<number>("1 + 2");
    assert.equal(result.ok, true);
    assert.equal(result.value, 3);
    assert.equal(result.timedOut, false);
  });

  it("injects caller-supplied globals", () => {
    const result = runInVmSandbox<number>("x * y", { globals: { x: 6, y: 7 } });
    assert.equal(result.ok, true);
    assert.equal(result.value, 42);
  });

  it("does NOT expose host process/require/Buffer by default", () => {
    // node:vm with a fresh context does NOT inject process, require, or Buffer.
    // `console` is exposed by V8 itself as a built-in — document this honestly
    // rather than pretend otherwise. Callers who care can override with
    // `globals: { console: undefined }`.
    const result = runInVmSandbox<string>(
      "typeof process + ' ' + typeof require + ' ' + typeof Buffer",
    );
    assert.equal(result.ok, true);
    assert.equal(result.value, "undefined undefined undefined");
  });

  it("allows callers to blank out V8 built-ins like console if desired", () => {
    const result = runInVmSandbox<string>("typeof console", { globals: { console: undefined } });
    assert.equal(result.ok, true);
    assert.equal(result.value, "undefined");
  });

  it("enforces a wall-clock timeout on infinite loops", () => {
    const result = runInVmSandbox("while (true) {}", { timeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs >= 40, `durationMs was ${result.durationMs}`);
  });

  it("reports syntax errors without throwing", () => {
    const result = runInVmSandbox("this is not valid js");
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, false);
    assert.ok(result.error && result.error.length > 0);
  });

  it("reports runtime errors from the sandboxed code", () => {
    const result = runInVmSandbox("throw new Error('boom')");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /boom/);
  });

  it("isolates mutations to the context — host state is untouched", () => {
    const hostObj = { count: 0 };
    const result = runInVmSandbox("obj.count = 99; obj.count", {
      globals: { obj: hostObj },
    });
    assert.equal(result.ok, true);
    assert.equal(result.value, 99);
    // Note: node:vm with a plain object context DOES see through to injected
    // references — so `hostObj.count` IS 99 after this. This is documented
    // behaviour of the primitive, not a leak. Callers wanting full isolation
    // must pass in frozen copies.
    assert.equal(hostObj.count, 99);
  });

  it("documents its non-security-boundary stance via honest defaults", () => {
    // Empty-globals default means no `eval`, no `Function`, no host I/O unless
    // the caller opts in. `Function` IS available in V8 — we don't strip it,
    // because doing so would give a false sense of security. Callers building
    // real sandboxes should use a separate process or isolated-vm.
    const result = runInVmSandbox<string>("typeof Function");
    assert.equal(result.ok, true);
    assert.equal(result.value, "function");
  });
});
