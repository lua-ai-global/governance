import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, tokenBudget } from "../index";
import {
  createGovernedMCP,
  GovernanceBlockedError,
} from "./mcp";
import type { MCPCallToolRequest, MCPCallToolResult, MCPReadResourceRequest, MCPContent } from "./mcp";

// ─── Mock Handlers ──────────────────────────────────────────

function mockToolCallHandler(results?: Record<string, MCPCallToolResult>) {
  return async (request: MCPCallToolRequest): Promise<MCPCallToolResult> => {
    const toolName = request.params.name;
    if (results?.[toolName]) return results[toolName];
    return { content: [{ type: "text", text: `Result from ${toolName}` }] };
  };
}

function mockResourceReadHandler(data?: Record<string, MCPContent[]>) {
  return async (request: MCPReadResourceRequest): Promise<MCPContent[]> => {
    const uri = request.params.uri;
    if (data?.[uri]) return data[uri];
    return [{ type: "text", text: `Content of ${uri}` }];
  };
}

function makeToolCallRequest(name: string, args?: Record<string, unknown>): MCPCallToolRequest {
  return { method: "tools/call", params: { name, arguments: args } };
}

function makeResourceRequest(uri: string): MCPReadResourceRequest {
  return { method: "resources/read", params: { uri } };
}

// ─── createGovernedMCP ──────────────────────────────────────

describe("createGovernedMCP", () => {
  test("registers agent and returns governed handlers", async () => {
    const gov = createGovernance();
    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-mcp-server",
      owner: "platform-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.ok(result.level >= 0);
    assert.ok(typeof result.handleToolCall === "function");
    assert.ok(typeof result.handleResourceRead === "function");
    assert.equal(result.governance, gov);
  });

  test("allows safe tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
    });

    const output = await result.handleToolCall(makeToolCallRequest("web_search", { query: "test" }));
    assert.equal(output.content[0].type, "text");
    assert.equal(output.content[0].text, "Result from web_search");
  });

  test("blocks dangerous tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec", "file_delete"])],
    });

    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.handleToolCall(makeToolCallRequest("shell_exec", { cmd: "rm -rf /" })),
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
    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
    });

    await result.handleToolCall(makeToolCallRequest("search"));

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.ok(toolCalls.length > 0);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on tool error", async () => {
    const gov = createGovernance();
    const result = await createGovernedMCP(gov, mockToolCallHandler({
      fail_tool: { content: [{ type: "text", text: "error" }], isError: true },
    }), {
      agentName: "test-server",
      owner: "test-team",
    });

    await result.handleToolCall(makeToolCallRequest("fail_tool"));

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  test("logs audit on handler exception", async () => {
    const gov = createGovernance();
    const failHandler = async () => {
      throw new Error("handler crashed");
    };

    const result = await createGovernedMCP(gov, failHandler, {
      agentName: "test-server",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.handleToolCall(makeToolCallRequest("crash_tool")),
      { message: "handler crashed" },
    );

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({
      rules: [blockTools(["danger"])],
    });

    let blockedTool = "";
    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
      onBlocked: (_decision, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.handleToolCall(makeToolCallRequest("danger")));
    assert.equal(blockedTool, "danger");
  });

  test("calls onDecision callback for every enforcement", async () => {
    const gov = createGovernance();
    const decisions: string[] = [];

    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
      onDecision: (_decision, toolName) => { decisions.push(toolName); },
    });

    await result.handleToolCall(makeToolCallRequest("tool_a"));
    await result.handleToolCall(makeToolCallRequest("tool_b"));
    assert.deepEqual(decisions, ["tool_a", "tool_b"]);
  });

  test("enforces token budget", async () => {
    const gov = createGovernance({
      rules: [tokenBudget(1000)],
    });

    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
      sessionTokenTracker: () => 1001,
    });

    await assert.rejects(
      () => result.handleToolCall(makeToolCallRequest("search")),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({
      rules: [blockTools(["blocked_tool"])],
    });

    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
    });

    const allowed = await result.enforce("safe_tool");
    assert.equal(allowed.blocked, false);

    await assert.rejects(result.enforce("blocked_tool"), { name: "GovernanceBlockedError" });
  });

  test("audit method works standalone", async () => {
    const gov = createGovernance();
    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
    });

    const event = await result.audit("my_tool", "success", { note: "manual" });
    assert.equal(event.outcome, "success");
    assert.equal(event.detail?.tool, "my_tool");
  });

  test("registers with mcp framework by default", async () => {
    const gov = createGovernance();
    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "mcp");
  });
});

// ─── Resource Governance ────────────────────────────────────

describe("MCP resource governance", () => {
  test("governs resource reads when enabled", async () => {
    const gov = createGovernance({
      rules: [blockTools(["secret://vault/keys"])],
    });

    const result = await createGovernedMCP(
      gov, mockToolCallHandler(), {
        agentName: "test-server",
        owner: "test-team",
      },
      mockResourceReadHandler(),
    );

    await assert.rejects(
      () => result.handleResourceRead(makeResourceRequest("secret://vault/keys")),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("allows safe resource reads", async () => {
    const gov = createGovernance();

    const result = await createGovernedMCP(
      gov, mockToolCallHandler(), {
        agentName: "test-server",
        owner: "test-team",
      },
      mockResourceReadHandler(),
    );

    const content = await result.handleResourceRead(makeResourceRequest("file:///readme.md"));
    assert.equal(content[0].text, "Content of file:///readme.md");
  });

  test("skips resource governance when disabled", async () => {
    const gov = createGovernance({
      rules: [blockTools(["secret://data"])],
    });

    const result = await createGovernedMCP(
      gov, mockToolCallHandler(), {
        agentName: "test-server",
        owner: "test-team",
        governResources: false,
      },
      mockResourceReadHandler(),
    );

    const content = await result.handleResourceRead(makeResourceRequest("secret://data"));
    assert.ok(content.length > 0);
  });

  test("returns fallback when no resource handler configured", async () => {
    const gov = createGovernance();
    const result = await createGovernedMCP(gov, mockToolCallHandler(), {
      agentName: "test-server",
      owner: "test-team",
    });

    const content = await result.handleResourceRead(makeResourceRequest("file:///test"));
    assert.equal(content[0].text, "No resource handler configured");
  });

  test("uses custom resourceActionMapper", async () => {
    const gov = createGovernance();
    const actions: string[] = [];

    const result = await createGovernedMCP(
      gov, mockToolCallHandler(), {
        agentName: "test-server",
        owner: "test-team",
        resourceActionMapper: (uri) => uri.startsWith("db://") ? "database_mutation" : "data_access",
        onDecision: (decision) => { actions.push(decision.outcome); },
      },
      mockResourceReadHandler(),
    );

    await result.handleResourceRead(makeResourceRequest("db://users"));
    assert.equal(actions.length, 1);
  });
});
