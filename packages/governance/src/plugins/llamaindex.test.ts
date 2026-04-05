import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, tokenBudget } from "../index";
import {
  governLlamaIndexTools,
  governLlamaIndexAgent,
  GovernanceBlockedError,
} from "./llamaindex";
import type { LlamaIndexTool, LlamaIndexAgent } from "./llamaindex";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, output: string = "result"): LlamaIndexTool {
  return {
    metadata: { name, description: `Mock ${name} tool` },
    call: async (_input: Record<string, unknown>) => output,
  };
}

function createMockAgent(tools: LlamaIndexTool[]): LlamaIndexAgent {
  return { tools };
}

// ─── governLlamaIndexTools ──────────────────────────────────

describe("governLlamaIndexTools", () => {
  test("wraps tools with governance and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governLlamaIndexTools(gov, tools, {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.equal(result.tools.length, 2);
    assert.equal(result.governance, gov);
  });

  test("allows safe tool calls", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", "found results")];

    const result = await governLlamaIndexTools(gov, tools, {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    const output = await result.tools[0].call({ query: "test" });
    assert.equal(output, "found results");
  });

  test("blocks dangerous tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });
    const tools = [createMockTool("shell_exec")];

    const result = await governLlamaIndexTools(gov, tools, {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    await assert.rejects(
      () => result.tools[0].call({ cmd: "rm -rf /" }),
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

    const result = await governLlamaIndexTools(gov, tools, {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    await result.tools[0].call({});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit on exception", async () => {
    const gov = createGovernance();
    const throwTool: LlamaIndexTool = {
      metadata: { name: "crash", description: "crashes" },
      call: async () => { throw new Error("tool crashed"); },
    };

    const result = await governLlamaIndexTools(gov, [throwTool], {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    await assert.rejects(() => result.tools[0].call({}), { message: "tool crashed" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });

    let blockedTool = "";
    const result = await governLlamaIndexTools(gov, [createMockTool("danger")], {
      agentName: "llamaindex-agent",
      owner: "ai-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.tools[0].call({}));
    assert.equal(blockedTool, "danger");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const result = await governLlamaIndexTools(gov, [createMockTool("allowed")], {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    await assert.rejects(result.enforce("blocked"), { name: "GovernanceBlockedError" });
  });

  test("preserves tool metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("my_tool")];

    const result = await governLlamaIndexTools(gov, tools, {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    assert.equal(result.tools[0].metadata.name, "my_tool");
    assert.equal(result.tools[0].metadata.description, "Mock my_tool tool");
  });

  test("enforces token budget", async () => {
    const gov = createGovernance({ rules: [tokenBudget(1000)] });
    const result = await governLlamaIndexTools(gov, [createMockTool("search")], {
      agentName: "llamaindex-agent",
      owner: "ai-team",
      sessionTokenTracker: () => 1001,
    });

    await assert.rejects(
      () => result.tools[0].call({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });
});

// ─── governLlamaIndexAgent ──────────────────────────────────

describe("governLlamaIndexAgent", () => {
  test("wraps agent tools with governance", async () => {
    const gov = createGovernance();
    const agent = createMockAgent([createMockTool("search"), createMockTool("write")]);

    const result = await governLlamaIndexAgent(gov, agent, {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.agent.tools.length, 2);
    assert.equal(result.governance, gov);
  });

  test("blocks agent tools per policy", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const agent = createMockAgent([createMockTool("shell_exec")]);

    const result = await governLlamaIndexAgent(gov, agent, {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    await assert.rejects(
      () => result.agent.tools[0].call({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("allows safe agent tool calls", async () => {
    const gov = createGovernance();
    const agent = createMockAgent([createMockTool("search", "found it")]);

    const result = await governLlamaIndexAgent(gov, agent, {
      agentName: "llamaindex-agent",
      owner: "ai-team",
    });

    const output = await result.agent.tools[0].call({ query: "test" });
    assert.equal(output, "found it");
  });
});
