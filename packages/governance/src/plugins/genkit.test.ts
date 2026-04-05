import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import {
  governGenkitTools,
  governGenkitFlow,
  GovernanceBlockedError,
} from "./genkit";
import type { GenkitTool, GenkitFlow } from "./genkit";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, result: unknown = "ok"): GenkitTool {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: "object" },
    call: async (_input: unknown) => result,
  };
}

function createMockFlow(name: string, result: unknown = "flow_result"): GenkitFlow {
  return {
    name,
    call: async (_input: unknown) => result,
  };
}

// ─── governGenkitTools ──────────────────────────────────────

describe("governGenkitTools", () => {
  test("wraps tools with governance and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governGenkitTools(gov, tools, {
      agentName: "genkit-agent",
      owner: "ai-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.equal(result.tools.length, 2);
    assert.equal(result.governance, gov);
  });

  test("allows safe tool calls", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", { results: ["found"] })];

    const result = await governGenkitTools(gov, tools, {
      agentName: "genkit-agent",
      owner: "ai-team",
    });

    const output = await result.tools[0].call({ query: "test" });
    assert.deepEqual(output, { results: ["found"] });
  });

  test("blocks dangerous tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["file_delete"])],
    });
    const tools = [createMockTool("file_delete")];

    const result = await governGenkitTools(gov, tools, {
      agentName: "genkit-agent",
      owner: "ai-team",
    });

    await assert.rejects(
      () => result.tools[0].call({ path: "/etc/passwd" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal(err.toolName, "file_delete");
        return true;
      },
    );
  });

  test("logs audit events on success", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", "results")];

    const result = await governGenkitTools(gov, tools, {
      agentName: "genkit-agent",
      owner: "ai-team",
    });

    await result.tools[0].call({});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failTool: GenkitTool = {
      name: "broken",
      description: "A tool that breaks",
      call: async () => { throw new Error("tool broke"); },
    };

    const result = await governGenkitTools(gov, [failTool], {
      agentName: "genkit-agent",
      owner: "ai-team",
    });

    await assert.rejects(() => result.tools[0].call({}), { message: "tool broke" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.equal(failures.length, 1);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });

    let blockedTool = "";
    const result = await governGenkitTools(gov, [createMockTool("danger")], {
      agentName: "genkit-agent",
      owner: "ai-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.tools[0].call({}));
    assert.equal(blockedTool, "danger");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const result = await governGenkitTools(gov, [createMockTool("allowed")], {
      agentName: "genkit-agent",
      owner: "ai-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    await assert.rejects(result.enforce("blocked"), { name: "GovernanceBlockedError" });
  });

  test("registers with genkit framework by default", async () => {
    const gov = createGovernance();
    const result = await governGenkitTools(gov, [createMockTool("t1")], {
      agentName: "genkit-agent",
      owner: "ai-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "genkit");
  });
});

// ─── governGenkitFlow ───────────────────────────────────────

describe("governGenkitFlow", () => {
  test("wraps flow with governance", async () => {
    const gov = createGovernance();
    const flow = createMockFlow("my-flow");

    const result = await governGenkitFlow(gov, flow, {
      agentName: "flow-agent",
      owner: "ai-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.flow.name, "my-flow");
  });

  test("allows safe flow execution", async () => {
    const gov = createGovernance();
    const flow = createMockFlow("my-flow", { answer: 42 });

    const result = await governGenkitFlow(gov, flow, {
      agentName: "flow-agent",
      owner: "ai-team",
    });

    const output = await result.flow.call({ question: "what" });
    assert.deepEqual(output, { answer: 42 });
  });

  test("blocks flow when policy blocks", async () => {
    const gov = createGovernance({
      rules: [blockTools(["dangerous-flow"])],
    });
    const flow = createMockFlow("dangerous-flow");

    const result = await governGenkitFlow(gov, flow, {
      agentName: "flow-agent",
      owner: "ai-team",
    });

    await assert.rejects(
      () => result.flow.call({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("handles non-object flow input", async () => {
    const gov = createGovernance();
    const flow = createMockFlow("text-flow", "processed");

    const result = await governGenkitFlow(gov, flow, {
      agentName: "flow-agent",
      owner: "ai-team",
    });

    const output = await result.flow.call("simple string input");
    assert.equal(output, "processed");
  });

  test("logs audit on flow failure", async () => {
    const gov = createGovernance();
    const failFlow: GenkitFlow = {
      name: "fail-flow",
      call: async () => { throw new Error("flow crashed"); },
    };

    const result = await governGenkitFlow(gov, failFlow, {
      agentName: "flow-agent",
      owner: "ai-team",
    });

    await assert.rejects(() => result.flow.call({}), { message: "flow crashed" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });
});
