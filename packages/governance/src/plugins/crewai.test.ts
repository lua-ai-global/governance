import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, tokenBudget } from "../index";
import {
  governCrewAIAgent,
  governCrewAITools,
  GovernanceBlockedError,
} from "./crewai";
import type { CrewAITool, CrewAIAgent } from "./crewai";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, result: unknown = "ok"): CrewAITool {
  return {
    name,
    description: `Mock ${name} tool`,
    execute: async (_input: Record<string, unknown>) => result,
  };
}

function createMockAgent(role: string, tools: CrewAITool[]): CrewAIAgent {
  return {
    role,
    goal: `${role} goal`,
    backstory: `${role} backstory`,
    tools,
  };
}

// ─── governCrewAIAgent ──────────────────────────────────────

describe("governCrewAIAgent", () => {
  test("wraps agent tools with governance and returns metadata", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("researcher", [
      createMockTool("web_search"),
      createMockTool("file_read"),
    ]);

    const result = await governCrewAIAgent(gov, agent, {
      agentName: "researcher",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.ok(result.level >= 0);
    assert.equal(result.agent.role, "researcher");
    assert.equal(result.agent.tools?.length, 2);
    assert.equal(result.governance, gov);
  });

  test("allows tool execution when no blocking rules", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("researcher", [
      createMockTool("web_search", { results: ["found"] }),
    ]);

    const result = await governCrewAIAgent(gov, agent, {
      agentName: "researcher",
      owner: "test-team",
    });

    const tool = result.agent.tools![0];
    const output = await tool.execute({ query: "hello" });
    assert.deepEqual(output, { results: ["found"] });
  });

  test("blocks tool execution when policy blocks", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });
    const agent = createMockAgent("coder", [createMockTool("shell_exec")]);

    const result = await governCrewAIAgent(gov, agent, {
      agentName: "coder",
      owner: "test-team",
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
    const agent = createMockAgent("researcher", [createMockTool("search", "results")]);

    const result = await governCrewAIAgent(gov, agent, {
      agentName: "researcher",
      owner: "test-team",
    });

    await result.agent.tools![0].execute({});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failTool: CrewAITool = {
      name: "bad_tool",
      description: "A tool that breaks",
      execute: async () => { throw new Error("tool broke"); },
    };
    const agent = createMockAgent("coder", [failTool]);

    const result = await governCrewAIAgent(gov, agent, {
      agentName: "coder",
      owner: "test-team",
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
    const result = await governCrewAIAgent(gov, agent, {
      agentName: "coder",
      owner: "test-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.agent.tools![0].execute({}));
    assert.equal(blockedTool, "danger");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const agent = createMockAgent("test", [createMockTool("allowed")]);

    const result = await governCrewAIAgent(gov, agent, {
      agentName: "test",
      owner: "test-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    assert.equal((await result.enforce("blocked")).blocked, true);
  });

  test("handles agent with no tools", async () => {
    const gov = createGovernance();
    const agent: CrewAIAgent = { role: "thinker" };

    const result = await governCrewAIAgent(gov, agent, {
      agentName: "thinker",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.agent.tools?.length, 0);
  });

  test("registers with crewai framework by default", async () => {
    const gov = createGovernance();
    const agent = createMockAgent("test", [createMockTool("t1")]);

    const result = await governCrewAIAgent(gov, agent, {
      agentName: "test",
      owner: "test-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "crewai");
  });
});

// ─── governCrewAITools ──────────────────────────────────────

describe("governCrewAITools", () => {
  test("wraps tools and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governCrewAITools(gov, tools, {
      agentName: "tool-agent",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.tools.length, 2);
  });

  test("blocks tools per policy", async () => {
    const gov = createGovernance({ rules: [blockTools(["shell_exec"])] });
    const tools = [createMockTool("shell_exec")];

    const result = await governCrewAITools(gov, tools, {
      agentName: "test",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.tools[0].execute({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("allows tools per policy", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("safe", "result")];

    const result = await governCrewAITools(gov, tools, {
      agentName: "test",
      owner: "test-team",
    });

    const output = await result.tools[0].execute({});
    assert.equal(output, "result");
  });
});
