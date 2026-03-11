import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, tokenBudget } from "../index";
import {
  governCloudflareTools,
  GovernanceBlockedError,
} from "./cloudflare-ai";
import type { CloudflareToolExecutor } from "./cloudflare-ai";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, result: unknown = "ok"): CloudflareToolExecutor {
  return {
    name,
    description: `Mock ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async (_args: Record<string, unknown>) => result,
  };
}

// ─── governCloudflareTools ──────────────────────────────────

describe("governCloudflareTools", () => {
  test("wraps tools with governance and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search"), createMockTool("write")];

    const result = await governCloudflareTools(gov, tools, {
      agentName: "edge-agent",
      owner: "platform-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.equal(result.tools.length, 2);
    assert.equal(result.governance, gov);
  });

  test("allows safe tool calls", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("search", { results: ["found"] })];

    const result = await governCloudflareTools(gov, tools, {
      agentName: "edge-agent",
      owner: "platform-team",
    });

    const output = await result.tools[0].execute({ query: "test" });
    assert.deepEqual(output, { results: ["found"] });
  });

  test("blocks dangerous tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });
    const tools = [createMockTool("shell_exec")];

    const result = await governCloudflareTools(gov, tools, {
      agentName: "edge-agent",
      owner: "platform-team",
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
    const tools = [createMockTool("search", "results")];

    const result = await governCloudflareTools(gov, tools, {
      agentName: "edge-agent",
      owner: "platform-team",
    });

    await result.tools[0].execute({});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failTool: CloudflareToolExecutor = {
      name: "broken",
      description: "breaks",
      execute: async () => { throw new Error("edge error"); },
    };

    const result = await governCloudflareTools(gov, [failTool], {
      agentName: "edge-agent",
      owner: "platform-team",
    });

    await assert.rejects(() => result.tools[0].execute({}), { message: "edge error" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });

    let blockedTool = "";
    const result = await governCloudflareTools(gov, [createMockTool("danger")], {
      agentName: "edge-agent",
      owner: "platform-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.tools[0].execute({}));
    assert.equal(blockedTool, "danger");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const result = await governCloudflareTools(gov, [createMockTool("allowed")], {
      agentName: "edge-agent",
      owner: "platform-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    assert.equal((await result.enforce("blocked")).blocked, true);
  });

  test("enforces token budget", async () => {
    const gov = createGovernance({ rules: [tokenBudget(1000)] });
    const result = await governCloudflareTools(gov, [createMockTool("search")], {
      agentName: "edge-agent",
      owner: "platform-team",
      sessionTokenTracker: () => 1001,
    });

    await assert.rejects(
      () => result.tools[0].execute({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("preserves tool metadata", async () => {
    const gov = createGovernance();
    const result = await governCloudflareTools(gov, [createMockTool("my_tool")], {
      agentName: "edge-agent",
      owner: "platform-team",
    });

    assert.equal(result.tools[0].name, "my_tool");
    assert.equal(result.tools[0].description, "Mock my_tool tool");
  });

  test("calls onDecision for every enforcement", async () => {
    const gov = createGovernance();
    const decisions: string[] = [];

    const result = await governCloudflareTools(gov, [createMockTool("t1"), createMockTool("t2")], {
      agentName: "edge-agent",
      owner: "platform-team",
      onDecision: (_d, toolName) => { decisions.push(toolName); },
    });

    await result.tools[0].execute({});
    await result.tools[1].execute({});
    assert.deepEqual(decisions, ["t1", "t2"]);
  });
});
