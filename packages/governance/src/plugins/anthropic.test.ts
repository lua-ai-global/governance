import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import { governAnthropicTools, GovernanceBlockedError } from "./anthropic";
import type { AnthropicToolExecutor, AnthropicToolUseBlock } from "./anthropic";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, result: string = "ok"): AnthropicToolExecutor {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: async (_input: Record<string, unknown>) => result,
  };
}

function createToolUseBlock(name: string, input: Record<string, unknown> = {}): AnthropicToolUseBlock {
  return { type: "tool_use", id: `toolu_${name}_123`, name, input };
}

// ─── governAnthropicTools ───────────────────────────────────

describe("governAnthropicTools", () => {
  test("wraps tools and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "claude-assistant",
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
    const tools = [createMockTool("search", "found it")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
      owner: "test-team",
    });

    const output = await result.tools[0].execute({ query: "hello" });
    assert.equal(output, "found it");
  });

  test("blocks tool execution when policy blocks", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const tools = [createMockTool("shell_exec")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.tools[0].execute({ cmd: "rm -rf /" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal(err.toolName, "shell_exec");
        assert.ok(err.decision.blocked);
        return true;
      },
    );
  });

  test("logs audit events on success", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", "results")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
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
    const failTool: AnthropicToolExecutor = {
      name: "bad_tool",
      inputSchema: {},
      execute: async () => { throw new Error("tool broke"); },
    };

    const result = await governAnthropicTools(gov, [failTool], {
      agentName: "assistant",
      owner: "test-team",
    });

    await assert.rejects(() => result.tools[0].execute({}), { message: "tool broke" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.equal(failures.length, 1);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });
    const tools = [createMockTool("danger")];

    let blockedTool = "";
    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
      owner: "test-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.tools[0].execute({}));
    assert.equal(blockedTool, "danger");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const tools = [createMockTool("allowed")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
      owner: "test-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    assert.equal((await result.enforce("blocked")).blocked, true);
  });

  test("registers with anthropic framework by default", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("t1")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
      owner: "test-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "anthropic");
  });
});

// ─── handleToolUse ──────────────────────────────────────────

describe("handleToolUse", () => {
  test("processes tool_use block and returns tool_result", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", "found it")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
      owner: "test-team",
    });

    const toolResult = await result.handleToolUse(createToolUseBlock("search", { query: "hello" }));
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.tool_use_id, "toolu_search_123");
    assert.equal(toolResult.content, "found it");
    assert.equal(toolResult.is_error, undefined);
  });

  test("returns error for unknown tool", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
      owner: "test-team",
    });

    const toolResult = await result.handleToolUse(createToolUseBlock("unknown_tool"));
    assert.equal(toolResult.is_error, true);
    assert.ok((toolResult.content as string).includes("Unknown tool"));
  });

  test("returns blocked error in tool_result", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const tools = [createMockTool("shell_exec")];

    const result = await governAnthropicTools(gov, tools, {
      agentName: "assistant",
      owner: "test-team",
    });

    const toolResult = await result.handleToolUse(createToolUseBlock("shell_exec"));
    assert.equal(toolResult.is_error, true);
    assert.ok((toolResult.content as string).includes("Blocked"));
  });

  test("returns error on execution failure", async () => {
    const gov = createGovernance();
    const failTool: AnthropicToolExecutor = {
      name: "fail",
      inputSchema: {},
      execute: async () => { throw new Error("boom"); },
    };

    const result = await governAnthropicTools(gov, [failTool], {
      agentName: "assistant",
      owner: "test-team",
    });

    const toolResult = await result.handleToolUse(createToolUseBlock("fail"));
    assert.equal(toolResult.is_error, true);
    assert.ok((toolResult.content as string).includes("boom"));
  });

  test("serializes non-string output to JSON", async () => {
    const gov = createGovernance();
    const objTool: AnthropicToolExecutor = {
      name: "data",
      inputSchema: {},
      execute: async () => [{ type: "text", text: "hello" }],
    };

    const result = await governAnthropicTools(gov, [objTool], {
      agentName: "assistant",
      owner: "test-team",
    });

    const toolResult = await result.handleToolUse(createToolUseBlock("data"));
    assert.ok(typeof toolResult.content === "string");
    assert.ok((toolResult.content as string).includes("hello"));
  });
});
