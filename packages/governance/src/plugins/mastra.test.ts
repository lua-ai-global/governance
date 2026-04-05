import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireLevel, tokenBudget } from "../index";
import { createGovernanceMiddleware, GovernanceBlockedError } from "./mastra";

describe("createGovernanceMiddleware", () => {
  test("registers agent and returns middleware", async () => {
    const gov = createGovernance();
    const mw = await createGovernanceMiddleware(gov, {
      agentName: "test-agent",
      owner: "test-team",
      framework: "mastra",
      hasAuth: true,
      hasGuardrails: true,
    });

    assert.ok(mw.agentId, "should have agent ID");
    assert.ok(mw.score > 0, "should have governance score");
    assert.ok(mw.level >= 0, "should have governance level");
  });

  test("beforeToolCall allows safe tools", async () => {
    const gov = createGovernance({
      rules: [blockTools(["dangerous_tool"])],
    });

    const mw = await createGovernanceMiddleware(gov, {
      agentName: "safe-agent",
      owner: "team",
    });

    const decision = await mw.beforeToolCall("web_search");
    assert.equal(decision.blocked, false);
  });

  test("beforeToolCall blocks dangerous tools", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec", "rm_rf"])],
    });

    const mw = await createGovernanceMiddleware(gov, {
      agentName: "guarded-agent",
      owner: "team",
    });

    await assert.rejects(
      mw.beforeToolCall("shell_exec"),
      (err: Error) => {
        assert.equal(err.name, "GovernanceBlockedError");
        assert.ok(err.message.includes("blocked"));
        return true;
      },
    );
  });

  test("wrapTool executes allowed tools", async () => {
    const gov = createGovernance({
      rules: [blockTools(["dangerous_tool"])],
    });

    const mw = await createGovernanceMiddleware(gov, {
      agentName: "wrapper-agent",
      owner: "team",
    });

    const safeTool = mw.wrapTool("web_search", async (input: { query: string }) => {
      return { results: [`Result for ${input.query}`] };
    });

    const result = await safeTool({ query: "test" });
    assert.deepEqual(result, { results: ["Result for test"] });
  });

  test("wrapTool throws GovernanceBlockedError for blocked tools", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const mw = await createGovernanceMiddleware(gov, {
      agentName: "blocked-agent",
      owner: "team",
    });

    const dangerousTool = mw.wrapTool("shell_exec", async (input: { cmd: string }) => {
      return { output: input.cmd };
    });

    await assert.rejects(
      () => dangerousTool({ cmd: "rm -rf /" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal(err.toolName, "shell_exec");
        assert.ok(err.decision.blocked);
        return true;
      },
    );
  });

  test("wrapTools wraps multiple tools", async () => {
    const gov = createGovernance({
      rules: [blockTools(["dangerous"])],
    });

    const mw = await createGovernanceMiddleware(gov, {
      agentName: "multi-agent",
      owner: "team",
    });

    const tools = mw.wrapTools({
      safe: async (input: Record<string, unknown>) => ({ ok: true, input }),
      dangerous: async (input: Record<string, unknown>) => ({ ok: true, input }),
    });

    const safeResult = await tools.safe({ key: "value" });
    assert.deepEqual(safeResult, { ok: true, input: { key: "value" } });

    await assert.rejects(() => tools.dangerous({ key: "value" }));
  });

  test("onBlocked callback fires on blocked decisions", async () => {
    const gov = createGovernance({
      rules: [blockTools(["bad_tool"])],
    });

    let blockedToolName: string | null = null;

    const mw = await createGovernanceMiddleware(gov, {
      agentName: "callback-agent",
      owner: "team",
      onBlocked: (_decision, toolName) => {
        blockedToolName = toolName;
      },
    });

    await assert.rejects(mw.beforeToolCall("bad_tool"), { name: "GovernanceBlockedError" });
    assert.equal(blockedToolName, "bad_tool");
  });

  test("afterToolCall logs to audit trail", async () => {
    const gov = createGovernance();

    const mw = await createGovernanceMiddleware(gov, {
      agentName: "audit-agent",
      owner: "team",
    });

    await mw.afterToolCall("web_search", "success", { query: "test" });

    const events = await gov.audit.query({ agentId: mw.agentId, eventType: "tool_call" });
    assert.ok(events.length >= 1, "should have tool_call audit event");
    assert.equal(events[0].outcome, "success");
  });

  test("token budget enforcement via sessionTokenTracker", async () => {
    let tokenCount = 5000;

    const gov = createGovernance({
      rules: [tokenBudget(50_000)],
    });

    const mw = await createGovernanceMiddleware(gov, {
      agentName: "token-agent",
      owner: "team",
      sessionTokenTracker: () => tokenCount,
    });

    // Under budget
    const d1 = await mw.beforeToolCall("search");
    assert.equal(d1.blocked, false);

    // Over budget
    tokenCount = 60_000;
    await assert.rejects(mw.beforeToolCall("search"), { name: "GovernanceBlockedError" });
  });
});
