import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools } from "../index";
import {
  governSKFunctions,
  governSKPlugin,
  GovernanceBlockedError,
} from "./semantic-kernel";
import type { KernelFunction, KernelPlugin, FunctionFilterContext } from "./semantic-kernel";

// ─── Mock Functions ─────────────────────────────────────────

function createMockFunction(name: string, result: unknown = "ok", pluginName?: string): KernelFunction {
  return {
    name,
    pluginName,
    description: `Mock ${name} function`,
    invoke: async (_args: Record<string, unknown>) => result,
  };
}

function createMockPlugin(name: string, functions: KernelFunction[]): KernelPlugin {
  const fns: Record<string, KernelFunction> = {};
  for (const fn of functions) {
    fns[fn.name] = fn;
  }
  return { name, description: `Mock ${name} plugin`, functions: fns };
}

// ─── governSKFunctions ──────────────────────────────────────

describe("governSKFunctions", () => {
  test("wraps functions with governance and returns metadata", async () => {
    const gov = createGovernance();
    const functions = [
      createMockFunction("search"),
      createMockFunction("write"),
    ];

    const result = await governSKFunctions(gov, functions, {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    assert.ok(result.agentId);
    assert.ok(result.score >= 0);
    assert.equal(result.functions.length, 2);
    assert.ok(result.filter);
    assert.equal(result.governance, gov);
  });

  test("allows safe function invocations", async () => {
    const gov = createGovernance();
    const functions = [createMockFunction("search", { results: ["found"] })];

    const result = await governSKFunctions(gov, functions, {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    const output = await result.functions[0].invoke({ query: "test" });
    assert.deepEqual(output, { results: ["found"] });
  });

  test("blocks dangerous function invocations", async () => {
    const gov = createGovernance({
      rules: [blockTools(["delete_file"])],
    });
    const functions = [createMockFunction("delete_file")];

    const result = await governSKFunctions(gov, functions, {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    await assert.rejects(
      () => result.functions[0].invoke({ path: "/etc/passwd" }),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal(err.toolName, "delete_file");
        return true;
      },
    );
  });

  test("uses pluginName.name as full function name", async () => {
    const gov = createGovernance({
      rules: [blockTools(["FilePlugin.delete"])],
    });
    const functions = [createMockFunction("delete", "ok", "FilePlugin")];

    const result = await governSKFunctions(gov, functions, {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    await assert.rejects(
      () => result.functions[0].invoke({}),
      (err: Error) => {
        assert.ok(err instanceof GovernanceBlockedError);
        assert.equal(err.toolName, "FilePlugin.delete");
        return true;
      },
    );
  });

  test("logs audit events on success", async () => {
    const gov = createGovernance();
    const functions = [createMockFunction("search", "results")];

    const result = await governSKFunctions(gov, functions, {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    await result.functions[0].invoke({});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].outcome, "success");
  });

  test("logs audit events on failure", async () => {
    const gov = createGovernance();
    const failFn: KernelFunction = {
      name: "broken",
      invoke: async () => { throw new Error("fn broke"); },
    };

    const result = await governSKFunctions(gov, [failFn], {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    await assert.rejects(() => result.functions[0].invoke({}), { message: "fn broke" });

    const events = await gov.audit.query({ agentId: result.agentId });
    const failures = events.filter((e) => e.outcome === "failure");
    assert.equal(failures.length, 1);
  });

  test("calls onBlocked callback", async () => {
    const gov = createGovernance({ rules: [blockTools(["danger"])] });

    let blockedTool = "";
    const result = await governSKFunctions(gov, [createMockFunction("danger")], {
      agentName: "sk-agent",
      owner: "ai-team",
      onBlocked: (_d, toolName) => { blockedTool = toolName; },
    });

    await assert.rejects(() => result.functions[0].invoke({}));
    assert.equal(blockedTool, "danger");
  });

  test("enforce method works standalone", async () => {
    const gov = createGovernance({ rules: [blockTools(["blocked"])] });
    const result = await governSKFunctions(gov, [createMockFunction("allowed")], {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    assert.equal((await result.enforce("allowed")).blocked, false);
    await assert.rejects(result.enforce("blocked"), { name: "GovernanceBlockedError" });
  });

  test("registers with semantic-kernel framework by default", async () => {
    const gov = createGovernance();
    const result = await governSKFunctions(gov, [createMockFunction("t1")], {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    const agents = await gov.storage.listAgents();
    const stored = agents.find((a) => a.id === result.agentId);
    assert.equal(stored?.framework, "semantic-kernel");
  });
});

// ─── FunctionFilter ─────────────────────────────────────────

describe("SK FunctionFilter", () => {
  test("filter.onFunctionInvocation blocks when policy blocks", async () => {
    const gov = createGovernance({
      rules: [blockTools(["danger"])],
    });

    const result = await governSKFunctions(gov, [createMockFunction("danger")], {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    const context: FunctionFilterContext = {
      function: createMockFunction("danger"),
      arguments: {},
    };

    await assert.rejects(
      () => result.filter.onFunctionInvocation(context, async () => {}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("filter.onFunctionInvocation passes and calls next when policy allows", async () => {
    const gov = createGovernance();

    const result = await governSKFunctions(gov, [createMockFunction("safe")], {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    const context: FunctionFilterContext = {
      function: createMockFunction("safe"),
      arguments: { query: "test" },
    };

    let nextCalled = false;
    await result.filter.onFunctionInvocation(context, async () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test("filter.onFunctionInvocation logs audit after next", async () => {
    const gov = createGovernance();

    const result = await governSKFunctions(gov, [createMockFunction("search")], {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    const context: FunctionFilterContext = {
      function: createMockFunction("search"),
      arguments: {},
      result: "found",
    };

    await result.filter.onFunctionInvocation(context, async () => {});

    const events = await gov.audit.query({ agentId: result.agentId });
    const toolCalls = events.filter((e) => e.eventType === "tool_call" && e.outcome === "success");
    assert.ok(toolCalls.length > 0);
  });
});

// ─── governSKPlugin ─────────────────────────────────────────

describe("governSKPlugin", () => {
  test("wraps plugin functions with governance", async () => {
    const gov = createGovernance();
    const plugin = createMockPlugin("FilePlugin", [
      createMockFunction("read", "content", "FilePlugin"),
      createMockFunction("write", "ok", "FilePlugin"),
    ]);

    const result = await governSKPlugin(gov, plugin, {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    assert.ok(result.agentId);
    assert.equal(result.plugin.name, "FilePlugin");
    assert.equal(Object.keys(result.plugin.functions).length, 2);
  });

  test("blocks plugin functions per policy", async () => {
    const gov = createGovernance({
      rules: [blockTools(["FilePlugin.delete"])],
    });
    const plugin = createMockPlugin("FilePlugin", [
      createMockFunction("delete", "ok", "FilePlugin"),
    ]);

    const result = await governSKPlugin(gov, plugin, {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    await assert.rejects(
      () => result.plugin.functions["delete"].invoke({}),
      (err: Error) => err instanceof GovernanceBlockedError,
    );
  });

  test("allows safe plugin function calls", async () => {
    const gov = createGovernance();
    const plugin = createMockPlugin("SearchPlugin", [
      createMockFunction("search", "results", "SearchPlugin"),
    ]);

    const result = await governSKPlugin(gov, plugin, {
      agentName: "sk-agent",
      owner: "ai-team",
    });

    const output = await result.plugin.functions["search"].invoke({});
    assert.equal(output, "results");
  });
});
