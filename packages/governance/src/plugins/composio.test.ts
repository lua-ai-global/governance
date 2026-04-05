import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import { governComposioTools, governComposioActions, GovernanceBlockedError } from "./composio";
import type { ComposioTool } from "./composio";

// ─── Mock Tools ─────────────────────────────────────────────

function createMockTool(name: string, toolkitSlug: string, result: unknown = { successful: true }): ComposioTool {
  return {
    name,
    description: `Mock ${name} tool`,
    toolkitSlug,
    execute: async (_params: Record<string, unknown>) => ({
      successful: true,
      data: result as Record<string, unknown>,
    }),
  };
}

// ─── governComposioTools ────────────────────────────────────

describe("governComposioTools", () => {
  test("wraps tools and returns metadata", async () => {
    const gov = createGovernance();
    const tools = [
      createMockTool("GMAIL_SEND_EMAIL", "gmail"),
      createMockTool("SLACK_POST_MESSAGE", "slack"),
    ];

    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.ok(result.level >= 0);
    assert.equal(result.tools.length, 2);
    assert.equal(result.governance, gov);
  });

  test("exposes both tools and actions (backward compat)", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("TEST", "test")];

    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
    });

    assert.equal(result.tools.length, 1);
    assert.equal(result.actions.length, 1);
    assert.equal(result.tools, result.actions);
  });

  test("allows tool execution when no blocking rules", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("GMAIL_SEND_EMAIL", "gmail", { messageId: "123" })];

    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
    });

    const output = await result.tools[0].execute({ to: "user@example.com", body: "hello" });
    assert.equal(output.successful, true);
    assert.deepEqual(output.data, { messageId: "123" });
  });

  test("blocks tool execution when policy blocks", async () => {
    const gov = createGovernance({ rules: [blockTools(["GMAIL_SEND_EMAIL"])] });
    const tools = [createMockTool("GMAIL_SEND_EMAIL", "gmail")];

    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.tools[0].execute({ to: "user@example.com" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal(err.toolName, "GMAIL_SEND_EMAIL");
        assert.ok(err.decision.blocked);
        return true;
      },
    );
  });

  test("logs audit events on success", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("SLACK_POST_MESSAGE", "slack")];

    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
    });

    await result.tools[0].execute({ channel: "#general", text: "hello" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failTool: ComposioTool = {
      name: "BAD_TOOL",
      toolkitSlug: "test",
      execute: async () => { throw new Error("tool broke"); },
    };

    const result = await governComposioTools(gov, [failTool], {
      agentName: "composio-agent",
      owner: "test-team",
    });

    await assert.rejects(() => result.tools[0].execute({}), { message: "tool broke" });

    const events = await gov.audit.query({ agentId: result.agentId });
    assert.equal(events.filter((e) => e.outcome === "failure").length, 1);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["DANGER_TOOL"])] });
    const tools = [createMockTool("DANGER_TOOL", "test")];

    let blockedTool = "";
    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.tools[0].execute({}));
    assert.equal(blockedTool, "DANGER_TOOL");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const tools = [createMockTool("allowed", "test")];

    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    await assert.rejects(result.enforce("blocked"), { name: "GovernanceBlockedError" });
  });

  test("registers with composio framework by default", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("TEST", "test")];

    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "composio");
  });

  test("uses toolkitActionMapper when provided", async () => {
    const gov = createGovernance();
    const tools = [createMockTool("GMAIL_SEND_EMAIL", "gmail")];

    let mappedToolkit = "";
    const result = await governComposioTools(gov, tools, {
      agentName: "composio-agent",
      owner: "test-team",
      toolkitActionMapper: (toolkit) => { mappedToolkit = toolkit; return "message_send"; },
    });

    await result.tools[0].execute({});
    assert.equal(mappedToolkit, "GMAIL");
  });

  test("governComposioActions is an alias for governComposioTools", () => {
    assert.equal(governComposioActions, governComposioTools);
  });
});
