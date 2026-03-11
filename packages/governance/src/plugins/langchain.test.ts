import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import { governTool, governTools, GovernanceBlockedError } from "./langchain";

// Mock LangChain tool shape
function mockLCTool(name: string, fn: (input: unknown) => Promise<unknown>) {
  return { name, description: `Mock: ${name}`, invoke: fn };
}

describe("governTool (LangChain single tool)", () => {
  it("registers agent and wraps tool", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const tool = mockLCTool("web_search", async (input) => `found: ${JSON.stringify(input)}`);
    const governed = await governTool(gov, tool, {
      agentName: "lc-agent",
      owner: "research",
      framework: "langchain",
    });

    assert.ok(governed.agentId);
    assert.ok(governed.score >= 0);
    assert.equal(governed.name, "web_search");
    assert.equal(governed.description, "Mock: web_search");
  });

  it("allows safe invocations", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const tool = mockLCTool("web_search", async () => "results");
    const governed = await governTool(gov, tool, {
      agentName: "lc-agent",
      owner: "research",
    });

    const output = await governed.invoke({ query: "test" });
    assert.equal(output, "results");
  });

  it("blocks dangerous tool", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const tool = mockLCTool("shell_exec", async () => "executed");
    const governed = await governTool(gov, tool, {
      agentName: "lc-agent",
      owner: "research",
    });

    await assert.rejects(
      () => governed.invoke({ command: "rm -rf /" }),
      (error: Error) => {
        assert.ok(error instanceof GovernanceBlockedError);
        assert.equal(error.toolName, "shell_exec");
        return true;
      },
    );
  });

  it("logs audit events on success", async () => {
    const gov = createGovernance();
    const tool = mockLCTool("search", async () => "ok");
    const governed = await governTool(gov, tool, {
      agentName: "lc-agent",
      owner: "research",
    });

    await governed.invoke({ q: "test" });

    const events = await gov.audit.query({ agentId: governed.agentId });
    const calls = events.filter((e) => e.eventType === "tool_call");
    assert.ok(calls.length > 0);
    assert.equal(calls[0].outcome, "success");
  });

  it("logs audit events on failure", async () => {
    const gov = createGovernance();
    const tool = mockLCTool("flaky", async () => {
      throw new Error("flaky error");
    });
    const governed = await governTool(gov, tool, {
      agentName: "lc-agent",
      owner: "research",
    });

    await assert.rejects(() => governed.invoke({}));

    const events = await gov.audit.query({ agentId: governed.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  it("calls onBlocked callback", async () => {
    const gov = createGovernance({
      rules: [blockTools(["rm_rf"])],
    });

    let blocked = false;
    const tool = mockLCTool("rm_rf", async () => "deleted");
    await governTool(gov, tool, {
      agentName: "lc-agent",
      owner: "research",
      onBlocked: () => { blocked = true; },
    });

    // The tool is governed, but we need to invoke to trigger
    const governed = await governTool(gov, tool, {
      agentName: "lc-agent-2",
      owner: "research",
      onBlocked: () => { blocked = true; },
    });

    await assert.rejects(() => governed.invoke({}));
    assert.ok(blocked);
  });
});

describe("governTools (LangChain multiple tools)", () => {
  it("registers agent with all tool names", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const tools = [
      mockLCTool("search", async () => "found"),
      mockLCTool("crm_update", async () => "updated"),
      mockLCTool("email_send", async () => "sent"),
    ];

    const result = await governTools(gov, tools, {
      agentName: "multi-agent",
      owner: "sales",
    });

    assert.equal(result.tools.length, 3);
    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
  });

  it("blocks dangerous tools in batch", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec", "database_drop"])],
    });

    const tools = [
      mockLCTool("search", async () => "ok"),
      mockLCTool("shell_exec", async () => "bad"),
    ];

    const result = await governTools(gov, tools, {
      agentName: "multi-agent",
      owner: "ops",
    });

    // Safe tool works
    const output = await result.tools[0].invoke({ q: "test" });
    assert.equal(output, "ok");

    // Dangerous tool blocked
    await assert.rejects(
      () => result.tools[1].invoke({}),
      (error: Error) => {
        assert.ok(error instanceof GovernanceBlockedError);
        return true;
      },
    );
  });

  it("preserves tool metadata", async () => {
    const gov = createGovernance();

    const tools = [
      mockLCTool("my_tool", async () => "result"),
    ];

    const result = await governTools(gov, tools, {
      agentName: "meta-agent",
      owner: "team",
    });

    assert.equal(result.tools[0].name, "my_tool");
    assert.equal(result.tools[0].description, "Mock: my_tool");
  });
});
