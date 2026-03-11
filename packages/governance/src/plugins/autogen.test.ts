import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, tokenBudget } from "../index";
import {
  governAutoGenAgent,
  governAutoGenTools,
  GovernanceBlockedError,
} from "./autogen";
import type { AutoGenTool, AutoGenAgent } from "./autogen";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, result: unknown = "ok"): AutoGenTool {
  return {
    name,
    description: `Mock ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async (_args: Record<string, unknown>) => result,
  };
}

function createMockAgent(name: string, tools: AutoGenTool[]): AutoGenAgent {
  return {
    name,
    systemMessage: `You are ${name}`,
    tools,
    description: `${name} agent`,
  };
}

// ─── governAutoGenAgent ─────────────────────────────────────

describe("governAutoGenAgent", () => {
  test("wraps agent tools with governance and returns metadata", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("coder", [
      createMockTool("exec_code"),
      createMockTool("write_file"),
    ]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.equal(result.agent.name, "coder");
    assert.equal(result.agent.tools?.length, 2);
    assert.equal(result.governance, gov);
  });

  test("allows tool execution when no blocking rules", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("coder", [
      createMockTool("exec_code", { output: "hello world" }),
    ]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
    });

    const tool = result.agent.tools![0];
    const output = await tool.execute({ code: "print('hello')" });
    assert.deepEqual(output, { output: "hello world" });
  });

  test("blocks tool execution when policy blocks", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });
    const agent = createMockAgent("coder", [createMockTool("shell_exec")]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
    });

    const tool = result.agent.tools![0];
    await assert.rejects(
      () => tool.execute({ cmd: "rm -rf /" }),
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
    const agent = createMockAgent("coder", [createMockTool("search", "results")]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
    });

    await result.agent.tools![0].execute({});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failTool: AutoGenTool = {
      name: "bad_tool",
      description: "A tool that breaks",
      execute: async () => { throw new Error("tool broke"); },
    };
    const agent = createMockAgent("coder", [failTool]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
    });

    await assert.rejects(() => result.agent.tools![0].execute({}), { message: "tool broke" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.equal(failures.length, 1);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });
    const agent = createMockAgent("coder", [createMockTool("danger")]);

    let blockedTool = "";
    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.agent.tools![0].execute({}));
    assert.equal(blockedTool, "danger");
  });

  test("calls onDecision callback for every enforcement", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("coder", [createMockTool("safe")]);

    const decisions: string[] = [];
    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
      onDecision: (_d, toolName) => { decisions.push(toolName); },
    });

    await result.agent.tools![0].execute({});
    assert.deepEqual(decisions, ["safe"]);
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const agent = createMockAgent("coder", [createMockTool("allowed")]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    assert.equal((await result.enforce("blocked")).blocked, true);
  });

  test("audit method works standalone", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("coder", [createMockTool("t1")]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
    });

    const event = await result.audit("t1", "success", { note: "manual" });
    assert.equal(event.outcome, "success");
    assert.equal(event.detail?.tool, "t1");
  });

  test("handles agent with no tools", async () => {
    const gov = createGovernance();
    const agent: AutoGenAgent = { name: "chat-only" };

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "chat-only",
      owner: "dev-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.agent.tools?.length, 0);
  });

  test("registers with autogen framework by default", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("coder", [createMockTool("t1")]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "autogen");
  });

  test("tracks session tokens via sessionTokenTracker", async () => {
    const gov = createGovernance({ rules: [tokenBudget(50_000)] });
    const agent = createMockAgent("coder", [createMockTool("search")]);

    const result = await governAutoGenAgent(gov, agent, {
      agentName: "coder",
      owner: "dev-team",
      sessionTokenTracker: () => 50_001,
    });

    await assert.rejects(
      () => result.agent.tools![0].execute({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });
});

// ─── governAutoGenTools ─────────────────────────────────────

describe("governAutoGenTools", () => {
  test("wraps tools and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governAutoGenTools(gov, tools, {
      agentName: "tool-agent",
      owner: "dev-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.tools.length, 2);
  });

  test("blocks tools per policy", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const tools = [createMockTool("shell_exec")];

    const result = await governAutoGenTools(gov, tools, {
      agentName: "test",
      owner: "dev-team",
    });

    await assert.rejects(
      () => result.tools[0].execute({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("allows tools per policy", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("safe", "result")];

    const result = await governAutoGenTools(gov, tools, {
      agentName: "test",
      owner: "dev-team",
    });

    const output = await result.tools[0].execute({});
    assert.equal(output, "result");
  });

  test("logs audit on success and failure", async () => {
    const gov = createGovernance();
    const failTool: AutoGenTool = {
      name: "fail",
      description: "A tool that fails",
      execute: async () => { throw new Error("broken"); },
    };
    const tools = [createMockTool("ok_tool", "fine"), failTool];

    const result = await governAutoGenTools(gov, tools, {
      agentName: "test",
      owner: "dev-team",
    });

    await result.tools[0].execute({});
    await assert.rejects(() => result.tools[1].execute!({}));

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolEvents = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolEvents.length, 2);
  });
});
