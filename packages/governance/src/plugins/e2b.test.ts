import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import { governE2BSandbox, GovernanceBlockedError } from "./e2b";
import type { E2BCodeExecution, E2BExecutionResult, E2BHandlers } from "./e2b";

// ─── Mock Handlers ──────────────────────────────────────────

function createMockHandlers(overrides?: Partial<E2BHandlers>): E2BHandlers {
  return {
    codeHandler: async (exec: E2BCodeExecution): Promise<E2BExecutionResult> => ({
      results: [{ type: "text", text: `executed: ${exec.code}` }],
      logs: { stdout: [`ran ${exec.language ?? "python"}`], stderr: [] },
    }),
    filesystemHandler: async (op) => ({ operation: op.operation, path: op.path, done: true }),
    commandHandler: async (cmd) => ({ command: cmd.command, exitCode: 0 }),
    ...overrides,
  };
}

// ─── governE2BSandbox ───────────────────────────────────────

describe("governE2BSandbox", () => {
  test("returns metadata after registration", async () => {
    const gov = createGovernance();
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox-runner",
      owner: "test-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.ok(result.level >= 0);
    assert.equal(result.governance, gov);
  });

  test("registers with e2b framework by default", async () => {
    const gov = createGovernance();
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox-runner",
      owner: "test-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "e2b");
  });
});

// ─── executeCode ────────────────────────────────────────────

describe("executeCode", () => {
  test("executes code when no blocking rules", async () => {
    const gov = createGovernance();
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    const output = await result.executeCode({ code: "print('hello')", language: "python" });
    assert.ok(output.results.length > 0);
    assert.ok(output.results[0].text?.includes("hello"));
  });

  test("blocks code execution when policy blocks", async () => {
    const gov = createGovernance({ rules: [blockTools(["code_execution"])] });
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.executeCode({ code: "print('hello')" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal((err as GovernanceBlockedError).toolName, "code_execution");
        return true;
      },
    );
  });

  test("blocks code matching blockedPatterns", async () => {
    const gov = createGovernance();
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
      blockedPatterns: ["import\\s+os", "subprocess"],
    });

    await assert.rejects(
      () => result.executeCode({ code: "import os\nos.system('rm -rf /')" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        return true;
      },
    );
  });

  test("logs audit on success", async () => {
    const gov = createGovernance();
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    await result.executeCode({ code: "1+1", language: "python" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call" && e.outcome === "success");
    assert.equal(toolCalls.length, 1);
  });

  test("logs audit on failure", async () => {
    const gov = createGovernance();
    const handlers = createMockHandlers({
      codeHandler: async () => { throw new Error("execution failed"); },
    });

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    await assert.rejects(() => result.executeCode({ code: "bad" }), { message: "execution failed" });

    const events = await gov.audit.query({ agentId: result.agentId });
    assert.equal(events.filter((e) => e.outcome === "failure").length, 1);
  });
});

// ─── filesystem ─────────────────────────────────────────────

describe("filesystem", () => {
  test("performs filesystem operation when allowed", async () => {
    const gov = createGovernance();
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    const output = await result.filesystem({ operation: "read", path: "/tmp/test.txt" });
    assert.ok(output);
  });

  test("blocks filesystem operation when policy blocks", async () => {
    const gov = createGovernance({ rules: [blockTools(["filesystem"])] });
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.filesystem({ operation: "write", path: "/etc/passwd", content: "hack" }),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("throws when no filesystem handler configured", async () => {
    const gov = createGovernance();
    const handlers: E2BHandlers = {
      codeHandler: async () => ({ results: [], logs: { stdout: [], stderr: [] } }),
    };

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.filesystem({ operation: "read", path: "/tmp/x" }),
      { message: "No filesystem handler configured" },
    );
  });
});

// ─── spawn ──────────────────────────────────────────────────

describe("spawn", () => {
  test("spawns process when allowed", async () => {
    const gov = createGovernance();
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    const output = await result.spawn({ command: "ls", args: ["-la"] });
    assert.ok(output);
  });

  test("blocks process spawn when policy blocks", async () => {
    const gov = createGovernance({ rules: [blockTools(["command_execution"])] });
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.spawn({ command: "rm", args: ["-rf", "/"] }),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("throws when no process handler configured", async () => {
    const gov = createGovernance();
    const handlers: E2BHandlers = {
      codeHandler: async () => ({ results: [], logs: { stdout: [], stderr: [] } }),
    };

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    await assert.rejects(
      () => result.spawn({ command: "ls" }),
      { message: "No command handler configured" },
    );
  });
});

// ─── enforce / audit standalone ─────────────────────────────

describe("enforce and audit", () => {
  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked_op"])] });
    const handlers = createMockHandlers();

    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
    });

    assert.equal((await result.enforce("code_execution")).blocked, false);
    await assert.rejects(result.enforce("blocked_op"), { name: "GovernanceBlockedError" });
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["code_execution"])] });
    const handlers = createMockHandlers();

    let blockedContext = "";
    const result = await governE2BSandbox(gov, handlers, {
      agentName: "sandbox",
      owner: "test-team",
      onBlocked: (_d, ctx) => { blockedContext = ctx; },
    });

    await assert.rejects(() => result.executeCode({ code: "test" }));
    assert.equal(blockedContext, "code_execution");
  });
});
