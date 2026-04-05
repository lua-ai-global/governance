import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, tokenBudget } from "../index";
import {
  governDenoAgent,
  governDenoTools,
  GovernanceBlockedError,
} from "./deno";
import type { DenoTool, DenoAgent } from "./deno";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, result: unknown = "ok"): DenoTool {
  return {
    name,
    description: `Mock ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async (_args: Record<string, unknown>) => result,
  };
}

function createMockAgent(name: string, tools: DenoTool[]): DenoAgent {
  return {
    name,
    description: `${name} agent`,
    tools,
    permissions: [
      { name: "read", path: "/data" },
      { name: "net", host: "api.example.com" },
    ],
  };
}

// ─── governDenoAgent ────────────────────────────────────────

describe("governDenoAgent", () => {
  test("wraps agent tools with governance and returns metadata", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("deno-agent", [
      createMockTool("read_file"),
      createMockTool("write_file"),
    ]);

    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.equal(result.agent.name, "deno-agent");
    assert.equal(result.agent.tools.length, 2);
    assert.equal(result.governance, gov);
  });

  test("allows safe tool calls", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("deno-agent", [
      createMockTool("read_file", "file contents"),
    ]);

    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
    });

    const output = await result.agent.tools[0].execute({ path: "/data/file.txt" });
    assert.equal(output, "file contents");
  });

  test("blocks dangerous tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });
    const agent = createMockAgent("deno-agent", [createMockTool("shell_exec")]);

    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
    });

    await assert.rejects(
      () => result.agent.tools[0].execute({ cmd: "rm -rf /" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal(err.toolName, "shell_exec");
        return true;
      },
    );
  });

  test("logs audit events on success", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("deno-agent", [createMockTool("search")]);

    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
    });

    await result.agent.tools[0].execute({});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failTool: DenoTool = {
      name: "broken",
      description: "breaks",
      execute: async () => { throw new Error("deno error"); },
    };
    const agent = createMockAgent("deno-agent", [failTool]);

    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
    });

    await assert.rejects(() => result.agent.tools[0].execute({}), { message: "deno error" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });
    const agent = createMockAgent("deno-agent", [createMockTool("danger")]);

    let blockedTool = "";
    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.agent.tools[0].execute({}));
    assert.equal(blockedTool, "danger");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const agent = createMockAgent("deno-agent", [createMockTool("allowed")]);

    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    await assert.rejects(result.enforce("blocked"), { name: "GovernanceBlockedError" });
  });

  test("preserves agent permissions in registration", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("deno-agent", [createMockTool("t1")]);

    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.ok(stored?.permissions);
  });

  test("handles agent with no permissions", async () => {
    const gov = createGovernance();
    const agent: DenoAgent = {
      name: "simple-agent",
      tools: [createMockTool("t1")],
    };

    const result = await governDenoAgent(gov, agent, {
      agentName: "simple-agent",
      owner: "platform-team",
    });

    assert.ok(result.agentId);
  });

  test("token budget enforcement", async () => {
    const gov = createGovernance({ rules: [tokenBudget(1000)] });
    const agent = createMockAgent("deno-agent", [createMockTool("search")]);

    const result = await governDenoAgent(gov, agent, {
      agentName: "deno-agent",
      owner: "platform-team",
      sessionTokenTracker: () => 1001,
    });

    await assert.rejects(
      () => result.agent.tools[0].execute({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });
});

// ─── governDenoTools ────────────────────────────────────────

describe("governDenoTools", () => {
  test("wraps tools and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governDenoTools(gov, tools, {
      agentName: "deno-tools",
      owner: "platform-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.tools.length, 2);
  });

  test("blocks tools per policy", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const result = await governDenoTools(gov, [createMockTool("shell_exec")], {
      agentName: "deno-tools",
      owner: "platform-team",
    });

    await assert.rejects(
      () => result.tools[0].execute({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("allows tools per policy", async () => {
    const gov = createGovernance();
    const result = await governDenoTools(gov, [createMockTool("safe", "result")], {
      agentName: "deno-tools",
      owner: "platform-team",
    });

    const output = await result.tools[0].execute({});
    assert.equal(output, "result");
  });

  test("logs audit on success and failure", async () => {
    const gov = createGovernance();
    const failTool: DenoTool = {
      name: "fail",
      description: "fails",
      execute: async () => { throw new Error("broken"); },
    };

    const result = await governDenoTools(gov, [createMockTool("ok"), failTool], {
      agentName: "deno-tools",
      owner: "platform-team",
    });

    await result.tools[0].execute({});
    await assert.rejects(() => result.tools[1].execute({}));

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolEvents = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolEvents.length, 2);
  });
});
