import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import {
  createGovernedA2A,
  GovernanceBlockedError,
} from "./a2a";
import type { A2AAgentCard, A2AMessageSendRequest, A2ATask } from "./a2a";

// ─── Mock Helpers ───────────────────────────────────────────

function mockAgentCard(name: string, url: string): A2AAgentCard {
  return {
    name,
    description: `${name} agent`,
    url,
    version: "1.0",
    protocolVersion: "0.2.6",
    capabilities: { streaming: true },
    skills: [{ id: "search", name: "Search", description: "Web search", tags: ["search"] }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
  };
}

function mockSendRequest(messageId: string, text: string): A2AMessageSendRequest {
  return {
    id: "req-1",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId,
        role: "user",
        parts: [{ kind: "text", text }],
      },
    },
  };
}

function mockTask(taskId: string, state: "completed" | "failed" = "completed"): A2ATask {
  return {
    kind: "task",
    id: taskId,
    contextId: "ctx-1",
    status: { state, timestamp: new Date().toISOString() },
  };
}

function mockSendHandler(result?: A2ATask) {
  return async (_req: A2AMessageSendRequest, _target: A2AAgentCard): Promise<A2ATask> =>
    result ?? mockTask("task-1");
}

function mockReceiveHandler(result?: A2ATask) {
  return async (_req: A2AMessageSendRequest, _from?: A2AAgentCard): Promise<A2ATask> =>
    result ?? mockTask("task-1");
}

// ─── createGovernedA2A ──────────────────────────────────────

describe("createGovernedA2A", () => {
  test("registers agent and returns governed handlers", async () => {
    const gov = createGovernance();
    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.ok(typeof result.sendMessage === "function");
    assert.ok(typeof result.receiveMessage === "function");
    // Backward compat aliases
    assert.ok(typeof result.sendTask === "function");
    assert.ok(typeof result.receiveTask === "function");
    assert.equal(result.governance, gov);
  });

  test("allows safe message sends", async () => {
    const gov = createGovernance();
    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    const task = await result.sendMessage(
      mockSendRequest("msg-1", "Hello"),
      mockAgentCard("target-agent", "https://target.example.com"),
    );
    assert.equal(task.id, "task-1");
    assert.equal(task.status.state, "completed");
  });

  test("blocks message sends to blocked agents", async () => {
    const gov = createGovernance({
      rules: [blockTools(["send:evil-agent@https://evil.example.com"])],
    });

    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    await assert.rejects(
      () => result.sendMessage(
        mockSendRequest("msg-1", "Hello"),
        mockAgentCard("evil-agent", "https://evil.example.com"),
      ),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.ok(err.decision.blocked);
        return true;
      },
    );
  });

  test("allows safe message receives", async () => {
    const gov = createGovernance();
    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    const task = await result.receiveMessage(
      mockSendRequest("msg-2", "Process this"),
      mockAgentCard("sender", "https://sender.example.com"),
    );
    assert.equal(task.id, "task-1");
  });

  test("blocks message receives from blocked senders", async () => {
    const gov = createGovernance({
      rules: [blockTools(["receive:malicious-agent"])],
    });

    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    await assert.rejects(
      () => result.receiveMessage(
        mockSendRequest("msg-1", "attack"),
        mockAgentCard("malicious-agent", "https://bad.example.com"),
      ),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("logs audit events on successful send", async () => {
    const gov = createGovernance();
    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    await result.sendMessage(
      mockSendRequest("msg-1", "Hello"),
      mockAgentCard("target", "https://target.example.com"),
    );

    const events = await gov.audit.query({ agentId: result.agentId });
    const sends = events.filter((e) => e.detail?.type === "a2a_send");
    assert.ok(sends.length > 0);
    assert.equal(sends[0].outcome, "success");
  });

  test("logs audit events on failed send", async () => {
    const gov = createGovernance();
    const failHandler = async () => { throw new Error("network error"); };

    const result = await createGovernedA2A(
      gov, failHandler, mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    await assert.rejects(
      () => result.sendMessage(
        mockSendRequest("msg-1", "Hello"),
        mockAgentCard("target", "https://target.example.com"),
      ),
      { message: "network error" },
    );

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.ok(failures.length > 0);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({
      rules: [blockTools(["send:blocked@https://blocked.com"])],
    });

    let blockedContext = "";
    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
        onBlocked: (_d, ctx) => { blockedContext = ctx; },
      },
    );

    await assert.rejects(() => result.sendMessage(
      mockSendRequest("msg-1", "Hi"),
      mockAgentCard("blocked", "https://blocked.com"),
    ));
    assert.equal(blockedContext, "send:blocked@https://blocked.com");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked_ctx"])] });
    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    assert.equal((await result.enforce("safe_ctx")).blocked, false);
    await assert.rejects(result.enforce("blocked_ctx"), { name: "GovernanceBlockedError" });
  });

  test("handles receive from unknown agent", async () => {
    const gov = createGovernance();
    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    const task = await result.receiveMessage(mockSendRequest("msg-1", "Hello"));
    assert.ok(task);
  });

  test("logs audit on receive", async () => {
    const gov = createGovernance();
    const result = await createGovernedA2A(
      gov, mockSendHandler(), mockReceiveHandler(), {
        agentName: "a2a-agent",
        owner: "platform-team",
      },
    );

    await result.receiveMessage(
      mockSendRequest("msg-2", "Process"),
      mockAgentCard("sender", "https://sender.com"),
    );

    const events = await gov.audit.query({ agentId: result.agentId });
    const receives = events.filter((e) => e.detail?.type === "a2a_receive");
    assert.ok(receives.length > 0);
  });
});
