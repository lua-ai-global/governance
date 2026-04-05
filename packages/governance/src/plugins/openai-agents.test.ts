import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireApproval, tokenBudget } from "../index";
import {
  governAgent,
  governTools,
  GovernanceBlockedError,
} from "./openai-agents";
import type { OpenAIFunctionTool, OpenAIAgent } from "./openai-agents";

// ─── Mock Tools ─────────────────────────────────────────────────

function createMockTool(name: string, result: unknown = "ok"): OpenAIFunctionTool {
  return {
    type: "function",
    name,
    description: `Mock ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async (_args: Record<string, unknown>) => result,
  };
}

function createMockAgent(
  name: string,
  tools: OpenAIFunctionTool[],
): OpenAIAgent {
  return {
    name,
    instructions: `You are ${name}`,
    tools,
    model: "gpt-4o",
  };
}

// ─── governAgent ────────────────────────────────────────────────

describe("governAgent", () => {
  test("wraps agent tools with governance and returns metadata", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("test-agent", [
      createMockTool("web_search"),
      createMockTool("file_read"),
    ]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score > 0);
    assert.ok(result.level >= 0);
    assert.equal(result.agent.name, "test-agent");
    assert.equal(result.agent.tools?.length, 2);
    assert.equal(result.governance, gov);
  });

  test("allows tool execution when no blocking rules", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("test-agent", [
      createMockTool("web_search", { results: ["foo"] }),
    ]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const tool = result.agent.tools![0] as OpenAIFunctionTool;
    const output = await tool.execute!({ query: "hello" });
    assert.deepEqual(output, { results: ["foo"] });
  });

  test("blocks tool execution when policy blocks", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });
    const agent = createMockAgent("test-agent", [
      createMockTool("shell_exec"),
    ]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const tool = result.agent.tools![0] as OpenAIFunctionTool;
    await assert.rejects(
      () => tool.execute!({ cmd: "rm -rf /" }),
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
    const agent = createMockAgent("test-agent", [
      createMockTool("web_search", "results"),
    ]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const tool = result.agent.tools![0] as OpenAIFunctionTool;
    await tool.execute!({ query: "test" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCallEvents = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCallEvents.length, 1);
    assert.equal(toolCallEvents[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failTool: OpenAIFunctionTool = {
      type: "function",
      name: "bad_tool",
      execute: async () => { throw new Error("tool broke"); },
    };
    const agent = createMockAgent("test-agent", [failTool]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const tool = result.agent.tools![0] as OpenAIFunctionTool;
    await assert.rejects(() => tool.execute!({}), { message: "tool broke" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failEvents = events.filter((e) => e.outcome === "failure");
    assert.equal(failEvents.length, 1);
  });

  test("calls onBlocked callback when tool is blocked", async () => {
    const gov = createGovernance({
      rules: [blockTools(["dangerous"])],
    });
    const agent = createMockAgent("test-agent", [
      createMockTool("dangerous"),
    ]);

    let blockedTool = "";
    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
      onBlocked: (_decision, toolName) => { blockedTool = toolName; },
    });

    const tool = result.agent.tools![0] as OpenAIFunctionTool;
    await assert.rejects(() => tool.execute!({}));
    assert.equal(blockedTool, "dangerous");
  });

  test("calls onDecision callback for every enforcement", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("test-agent", [
      createMockTool("safe_tool"),
    ]);

    const decisions: string[] = [];
    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
      onDecision: (_decision, toolName) => { decisions.push(toolName); },
    });

    const tool = result.agent.tools![0] as OpenAIFunctionTool;
    await tool.execute!({});
    assert.deepEqual(decisions, ["safe_tool"]);
  });

  test("uses agent instructions as description fallback", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("test-agent", [createMockTool("t1")]);
    agent.instructions = "Research assistant for data analysis";

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "research-team",
    });

    assert.ok(result.agentId);
  });

  test("preserves non-function tools unchanged", async () => {
    const gov = createGovernance();
    const nonFuncTool = { type: "code_interpreter" as const, name: "ci" } as unknown as OpenAIFunctionTool;
    const agent: OpenAIAgent = {
      name: "test-agent",
      tools: [nonFuncTool, createMockTool("search")],
    };

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    assert.equal(result.agent.tools?.length, 2);
  });

  test("handles agent with no tools", async () => {
    const gov = createGovernance();
    const agent: OpenAIAgent = { name: "chat-only" };

    const result = await governAgent(gov, agent, {
      agentName: "chat-only",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.agent.tools?.length, 0);
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({
      rules: [blockTools(["blocked_tool"])],
    });
    const agent = createMockAgent("test-agent", [createMockTool("allowed")]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const allowed = await result.enforce("allowed");
    assert.equal(allowed.blocked, false);

    await assert.rejects(result.enforce("blocked_tool"), { name: "GovernanceBlockedError" });
  });

  test("audit method works standalone", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("test-agent", [createMockTool("t1")]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const event = await result.audit("t1", "success", { note: "manual" });
    assert.equal(event.outcome, "success");
    assert.equal(event.detail?.tool, "t1");
    assert.equal(event.detail?.note, "manual");
  });

  test("uses custom actionMapper", async () => {
    const gov = createGovernance({
      rules: [blockTools(["data_access_tool"])],
    });
    const agent = createMockAgent("test-agent", [
      createMockTool("read_database"),
    ]);

    const decisions: string[] = [];
    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
      actionMapper: (toolName) =>
        toolName.startsWith("read_") ? "data_access" : "tool_call",
      onDecision: (decision) => { decisions.push(decision.outcome); },
    });

    // The actionMapper maps read_database to "data_access" action,
    // but the rule blocks tool "data_access_tool" not action "data_access"
    const tool = result.agent.tools![0] as OpenAIFunctionTool;
    await tool.execute!({});
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0], "allow");
  });

  test("tracks session tokens via sessionTokenTracker", async () => {
    let tokenCount = 50_001;
    const gov = createGovernance({
      rules: [tokenBudget(50_000)],
    });
    const agent = createMockAgent("test-agent", [
      createMockTool("search"),
    ]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
      sessionTokenTracker: () => tokenCount,
    });

    const tool = result.agent.tools![0] as OpenAIFunctionTool;
    await assert.rejects(
      () => tool.execute!({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("registers with openai framework by default", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("test-agent", [createMockTool("t1")]);

    const result = await governAgent(gov, agent, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "openai");
  });
});

// ─── governTools ────────────────────────────────────────────────

describe("governTools (OpenAI)", () => {
  test("wraps tools and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governTools(gov, tools, {
      agentName: "tool-agent",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score > 0);
    assert.equal(result.tools.length, 2);
  });

  test("blocks tools per policy", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });
    const tools = [createMockTool("shell_exec")];

    const result = await governTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.tools[0].execute!({ cmd: "ls" }),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("allows tools per policy", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("safe_tool", "result")];

    const result = await governTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const output = await result.tools[0].execute!({});
    assert.equal(output, "result");
  });

  test("preserves tools without execute", async () => {
    const gov = createGovernance();
    const noExecTool: OpenAIFunctionTool = {
      type: "function",
      name: "schema_only",
      description: "No execute",
      parameters: {},
    };

    const result = await governTools(gov, [noExecTool], {
      agentName: "test-agent",
      owner: "test-team",
    });

    assert.equal(result.tools[0].name, "schema_only");
    assert.equal(result.tools[0].execute, undefined);
  });

  test("logs audit on success and failure", async () => {
    const gov = createGovernance();
    const failTool: OpenAIFunctionTool = {
      type: "function",
      name: "fail",
      execute: async () => { throw new Error("broken"); },
    };
    const tools = [createMockTool("ok_tool", "fine"), failTool];

    const result = await governTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
    });

    await result.tools[0].execute!({});
    await assert.rejects(() => result.tools[1].execute!({}));

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolEvents = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolEvents.length, 2);
  });
});
