import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireLevel } from "../index";
import { createGovernedTools, GovernanceBlockedError } from "./vercel-ai";

// Mock Vercel AI SDK tool shape
function mockTool(name: string, fn: (input: Record<string, unknown>) => Promise<unknown>) {
  return {
    description: `Mock tool: ${name}`,
    parameters: {},
    execute: fn,
  };
}

describe("createGovernedTools (Vercel AI SDK)", () => {
  it("registers agent and returns governed tools", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const tools = {
      webSearch: mockTool("webSearch", async ({ query }) => `results for ${query}`),
      crmUpdate: mockTool("crmUpdate", async ({ id }) => `updated ${id}`),
    };

    const result = await createGovernedTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
      framework: "vercel-ai",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.ok(result.level >= 0);
    assert.ok(result.tools.webSearch);
    assert.ok(result.tools.crmUpdate);
  });

  it("allows safe tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const tools = {
      webSearch: mockTool("webSearch", async () => "search results"),
    };

    const result = await createGovernedTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
    });

    const output = await result.tools.webSearch.execute!({ query: "test" });
    assert.equal(output, "search results");
  });

  it("blocks dangerous tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec", "database_drop"])],
    });

    const tools = {
      shell_exec: mockTool("shell_exec", async () => "executed"),
    };

    const result = await createGovernedTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.tools.shell_exec.execute!({ command: "rm -rf /" }),
      (error: Error) => {
        assert.ok(error instanceof GovernanceBlockedError);
        assert.ok(error.decision.blocked);
        assert.equal(error.toolName, "shell_exec");
        return true;
      },
    );
  });

  it("logs to audit trail on success", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const tools = {
      webSearch: mockTool("webSearch", async () => "results"),
    };

    const result = await createGovernedTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
    });

    await result.tools.webSearch.execute!({ query: "test" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.ok(toolCalls.length > 0);
    assert.equal(toolCalls[0].outcome, "success");
  });

  it("logs to audit trail on failure", async () => {
    const gov = createGovernance();

    const tools = {
      failTool: mockTool("failTool", async () => {
        throw new Error("tool failed");
      }),
    };

    const result = await createGovernedTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
    });

    await assert.rejects(() => result.tools.failTool.execute!({}));

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  it("calls onBlocked callback", async () => {
    const gov = createGovernance({
      rules: [blockTools(["danger"])],
    });

    const tools = {
      danger: mockTool("danger", async () => "nope"),
    };

    let blockedTool = "";
    const result = await createGovernedTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
      onBlocked: (_decision, toolName) => {
        blockedTool = toolName;
      },
    });

    await assert.rejects(() => result.tools.danger.execute!({}));
    assert.equal(blockedTool, "danger");
  });

  it("supports token budget enforcement", async () => {
    let tokens = 0;
    const gov = createGovernance({
      rules: [
        blockTools(["shell_exec"]),
        {
          id: "token-limit",
          name: "Token limit",
          condition: { type: "token_limit", maxTokens: 1000 },
          outcome: "block" as const,
          reason: "Token budget exceeded",
          priority: 70,
          enabled: true,
        },
      ],
    });

    const tools = {
      search: mockTool("search", async () => {
        tokens += 500;
        return "results";
      }),
    };

    const result = await createGovernedTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
      sessionTokenTracker: () => tokens,
    });

    // First call: under budget
    await result.tools.search.execute!({ query: "test" });
    tokens = 500;

    // Second call: still under
    await result.tools.search.execute!({ query: "test2" });
    tokens = 1000;

    // Third call: over budget — should be blocked
    tokens = 1001;
    await assert.rejects(
      () => result.tools.search.execute!({ query: "test3" }),
      (error: Error) => {
        assert.ok(error instanceof GovernanceBlockedError);
        return true;
      },
    );
  });

  it("handles tools without execute function", async () => {
    const gov = createGovernance();

    const tools = {
      noExec: { description: "No execute", parameters: {} },
    };

    const result = await createGovernedTools(gov, tools, {
      agentName: "test-agent",
      owner: "test-team",
    });

    assert.equal(result.tools.noExec.execute, undefined);
  });
});
