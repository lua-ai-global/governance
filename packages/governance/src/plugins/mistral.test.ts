import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import { governMistralTools, GovernanceBlockedError } from "./mistral";
import type { MistralToolExecutor, MistralToolCall } from "./mistral";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, result: unknown = "ok"): MistralToolExecutor {
  return {
    name,
    description: `Mock ${name} tool`,
    execute: async (_args: Record<string, unknown>) => result,
  };
}

function createMockToolCall(name: string, args: Record<string, unknown> = {}, asObject = false): MistralToolCall {
  return {
    id: `call_${name}_123`,
    type: "function",
    function: { name, arguments: asObject ? args : JSON.stringify(args) },
  };
}

// ─── governMistralTools ─────────────────────────────────────

describe("governMistralTools", () => {
  test("wraps tools and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.ok(result.level >= 0);
    assert.equal(result.tools.length, 2);
    assert.equal(result.governance, gov);
  });

  test("allows tool execution when no blocking rules", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", { results: ["found"] })];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const output = await result.tools[0].execute({ query: "hello" });
    assert.deepEqual(output, { results: ["found"] });
  });

  test("blocks tool execution when policy blocks", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const tools = [createMockTool("shell_exec")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.tools[0].execute({ cmd: "rm -rf /" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal(err.toolName, "shell_exec");
        return true;
      },
    );
  });

  test("logs audit events on success", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    await result.tools[0].execute({});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failTool: MistralToolExecutor = {
      name: "bad_tool",
      description: "fails",
      execute: async () => { throw new Error("tool broke"); },
    };

    const result = await governMistralTools(gov, [failTool], {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    await assert.rejects(() => result.tools[0].execute({}), { message: "tool broke" });

    const events = await gov.audit.query({ agentId: result.agentId });
    assert.equal(events.filter((e) => e.outcome === "failure").length, 1);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });
    const tools = [createMockTool("danger")];

    let blockedTool = "";
    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.tools[0].execute({}));
    assert.equal(blockedTool, "danger");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const tools = [createMockTool("allowed")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    await assert.rejects(result.enforce("blocked"), { name: "GovernanceBlockedError" });
  });

  test("registers with mistral framework by default", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("t1")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "mistral");
  });
});

// ─── handleToolCall ─────────────────────────────────────────

describe("handleToolCall", () => {
  test("processes tool call and returns result", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", "found it")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const response = await result.handleToolCall(createMockToolCall("search", { q: "hello" }));
    assert.equal(response.toolCallId, "call_search_123");
    assert.equal(response.content, "found it");
  });

  test("returns error for unknown tool", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const response = await result.handleToolCall(createMockToolCall("unknown"));
    assert.ok(response.content.includes("Unknown tool"));
  });

  test("returns blocked message", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const tools = [createMockTool("shell_exec")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const response = await result.handleToolCall(createMockToolCall("shell_exec"));
    assert.ok(response.content.includes("Blocked"));
  });

  test("returns error message on execution failure", async () => {
    const gov = createGovernance();
    const failTool: MistralToolExecutor = {
      name: "fail",
      description: "fails",
      execute: async () => { throw new Error("boom"); },
    };

    const result = await governMistralTools(gov, [failTool], {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const response = await result.handleToolCall(createMockToolCall("fail"));
    assert.ok(response.content.includes("boom"));
  });

  test("serializes non-string output to JSON", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("data", { count: 42 })];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const response = await result.handleToolCall(createMockToolCall("data"));
    assert.ok(response.content.includes("42"));
  });

  test("handles arguments as pre-parsed object", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", "found it")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const response = await result.handleToolCall(createMockToolCall("search", { q: "hello" }, true));
    assert.equal(response.content, "found it");
  });

  test("handles optional id on tool call", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", "found it")];

    const result = await governMistralTools(gov, tools, {
      agentName: "mistral-agent",
      owner: "test-team",
    });

    const toolCall: MistralToolCall = {
      type: "function",
      function: { name: "search", arguments: "{}" },
    };
    const response = await result.handleToolCall(toolCall);
    assert.ok(response.toolCallId.startsWith("call_search_"));
    assert.equal(response.content, "found it");
  });
});
