import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import {
  createGovernedBedrock,
  GovernanceBlockedError,
} from "./bedrock";
import type { BedrockInvokeAgentInput, BedrockActionGroupInvocation, BedrockToolUseBlock } from "./bedrock";

// ─── Mock Handlers ──────────────────────────────────────────

function mockInvokeHandler(result: unknown = { completion: "done" }) {
  return async (_input: BedrockInvokeAgentInput): Promise<unknown> => result;
}

function makeInvokeInput(overrides?: Partial<BedrockInvokeAgentInput>): BedrockInvokeAgentInput {
  return {
    agentId: "agent-123",
    agentAliasId: "alias-456",
    sessionId: "session-789",
    inputText: "Hello",
    ...overrides,
  };
}

// ─── createGovernedBedrock ──────────────────────────────────

describe("createGovernedBedrock", () => {
  test("registers agent and returns governed handlers", async () => {
    const gov = createGovernance();
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.ok(result.level >= 0);
    assert.ok(typeof result.invokeAgent === "function");
    assert.ok(typeof result.guardActionGroup === "function");
    assert.equal(result.governance, gov);
  });

  test("allows safe agent invocations", async () => {
    const gov = createGovernance();
    const result = await createGovernedBedrock(gov, mockInvokeHandler({ answer: "42" }), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    const output = await result.invokeAgent(makeInvokeInput());
    assert.deepEqual(output, { answer: "42" });
  });

  test("blocks agent invocation when policy blocks", async () => {
    const gov = createGovernance({
      rules: [blockTools(["bedrock:agent-123:alias-456"])],
    });

    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    await assert.rejects(
      () => result.invokeAgent(makeInvokeInput()),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.ok(err.decision.blocked);
        return true;
      },
    );
  });

  test("logs audit events on success", async () => {
    const gov = createGovernance();
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    await result.invokeAgent(makeInvokeInput());

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.ok(toolCalls.length > 0);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on handler failure", async () => {
    const gov = createGovernance();
    const failHandler = async () => { throw new Error("AWS error"); };

    const result = await createGovernedBedrock(gov, failHandler, {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    await assert.rejects(
      () => result.invokeAgent(makeInvokeInput()),
      { message: "AWS error" },
    );

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({
      rules: [blockTools(["bedrock:agent-123:alias-456"])],
    });

    let blockedTool = "";
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.invokeAgent(makeInvokeInput()));
    assert.equal(blockedTool, "bedrock:agent-123:alias-456");
  });

  test("registers with bedrock framework by default", async () => {
    const gov = createGovernance();
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "bedrock");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked_tool"])] });
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    assert.equal((await result.enforce("safe_tool")).blocked, false);
    await assert.rejects(result.enforce("blocked_tool"), { name: "GovernanceBlockedError" });
  });
});

// ─── guardActionGroup ───────────────────────────────────────

describe("guardActionGroup", () => {
  test("allows safe action groups", async () => {
    const gov = createGovernance();
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    const invocation: BedrockActionGroupInvocation = {
      actionGroupName: "search_records",
      apiPath: "/records",
      verb: "GET",
    };

    const decision = await result.guardActionGroup(invocation);
    assert.equal(decision.blocked, false);
  });

  test("blocks dangerous action groups", async () => {
    const gov = createGovernance({
      rules: [blockTools(["delete_records"])],
    });

    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    const invocation: BedrockActionGroupInvocation = {
      actionGroupName: "delete_records",
      apiPath: "/records/123",
      verb: "DELETE",
    };

    await assert.rejects(result.guardActionGroup(invocation), { name: "GovernanceBlockedError" });
  });

  test("includes parameters in enforcement context", async () => {
    const gov = createGovernance();
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    const invocation: BedrockActionGroupInvocation = {
      actionGroupName: "update_record",
      apiPath: "/records/123",
      verb: "PUT",
      parameters: [
        { name: "id", value: "123" },
        { name: "status", value: "active" },
      ],
    };

    const decision = await result.guardActionGroup(invocation);
    assert.equal(decision.blocked, false);
  });
});

// ─── guardToolUse (Converse API) ──────────────────────────

describe("guardToolUse", () => {
  test("allows safe tool_use blocks", async () => {
    const gov = createGovernance();
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    const block: BedrockToolUseBlock = {
      toolUseId: "tu-1",
      name: "search_docs",
      input: { query: "hello" },
    };

    const decision = await result.guardToolUse(block);
    assert.equal(decision.blocked, false);
  });

  test("blocks dangerous tool_use blocks", async () => {
    const gov = createGovernance({
      rules: [blockTools(["delete_all"])],
    });

    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    const block: BedrockToolUseBlock = {
      toolUseId: "tu-2",
      name: "delete_all",
      input: {},
    };

    await assert.rejects(result.guardToolUse(block), { name: "GovernanceBlockedError" });
  });

  test("logs audit on tool_use guard", async () => {
    const gov = createGovernance();
    const result = await createGovernedBedrock(gov, mockInvokeHandler(), {
      agentName: "bedrock-agent",
      owner: "cloud-team",
    });

    await result.guardToolUse({ toolUseId: "tu-3", name: "safe_tool", input: {} });

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call" && e.detail?.type === "tool_use_allowed");
    assert.ok(toolCalls.length > 0);
  });
});
