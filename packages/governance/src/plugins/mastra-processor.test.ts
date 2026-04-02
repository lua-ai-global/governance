import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGovernance, blockTools, requireLevel, tokenBudget } from "../index";
import { GovernanceProcessor } from "./mastra-processor";
import type { MastraToolCallInfo, ProcessOutputStepArgs, MastraAbortOptions } from "./mastra-processor";

function makeToolCall(toolName: string, args: Record<string, unknown> = {}): MastraToolCallInfo {
  return { toolName, args, toolCallId: `tc_${Math.random().toString(36).slice(2)}` };
}

/** Create ProcessOutputStepArgs with tool calls and a mock abort function */
function makeArgs(
  toolCalls: MastraToolCallInfo[],
  overrides: {
    onAbort?: (reason?: string, options?: MastraAbortOptions<{ violations: unknown[] }>) => void;
    retryCount?: number;
  } = {},
): ProcessOutputStepArgs {
  return {
    toolCalls,
    text: "",
    abort: ((reason?: string, options?: MastraAbortOptions<{ violations: unknown[] }>) => {
      overrides.onAbort?.(reason, options);
    }) as ProcessOutputStepArgs["abort"],
    retryCount: overrides.retryCount ?? 0,
    stepNumber: 0,
    messages: [],
    systemMessages: [],
    steps: [],
    state: {},
  };
}

describe("GovernanceProcessor", () => {
  it("has an id and name", () => {
    const gov = createGovernance({});
    const processor = new GovernanceProcessor(gov, {
      agentName: "test-agent",
      owner: "test-team",
    });
    assert.equal(processor.id, "governance-sdk");
    assert.equal(processor.name, "Lua Governance Processor");
  });

  it("auto-registers agent on first processOutputStep", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const processor = new GovernanceProcessor(gov, {
      agentName: "test-agent",
      owner: "test-team",
    });

    assert.equal(processor.getAgentId(), null);

    await processor.processOutputStep(makeArgs([makeToolCall("web_search", { query: "hello" })]));

    assert.notEqual(processor.getAgentId(), null);
    assert.equal(typeof processor.getAgentId(), "string");
  });

  it("allows safe tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec", "rm_rf"])],
    });

    const decisions: Array<{ toolName: string; blocked: boolean }> = [];
    const processor = new GovernanceProcessor(gov, {
      agentName: "safe-agent",
      owner: "test-team",
      onDecision: (d, tc) => decisions.push({ toolName: tc.toolName, blocked: d.blocked }),
    });

    await processor.processOutputStep(makeArgs([
      makeToolCall("web_search", { query: "typescript governance" }),
      makeToolCall("crm_update", { id: "123" }),
    ]));

    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].blocked, false);
    assert.equal(decisions[1].blocked, false);

    const stats = processor.getStats();
    assert.equal(stats.totalProcessed, 2);
    assert.equal(stats.totalAllowed, 2);
    assert.equal(stats.totalBlocked, 0);
  });

  it("blocks dangerous tool calls and aborts", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec", "database_drop"])],
    });

    let aborted = false;
    let abortReason = "";
    const blockedTools: string[] = [];

    const processor = new GovernanceProcessor(gov, {
      agentName: "danger-agent",
      owner: "test-team",
      onBlocked: (_d, tc) => blockedTools.push(tc.toolName),
    });

    await processor.processOutputStep(makeArgs(
      [
        makeToolCall("shell_exec", { command: "rm -rf /" }),
        makeToolCall("web_search", { query: "safe" }), // should NOT be reached
      ],
      {
        onAbort: (reason) => {
          aborted = true;
          abortReason = reason ?? "";
        },
      },
    ));

    assert.equal(aborted, true);
    assert.ok(abortReason.includes("[GOVERNANCE]"));
    assert.ok(abortReason.includes("shell_exec"));
    assert.equal(blockedTools.length, 1);
    assert.equal(blockedTools[0], "shell_exec");

    // Only first tool was processed (abort stops further processing)
    const stats = processor.getStats();
    assert.equal(stats.totalProcessed, 1);
    assert.equal(stats.totalBlocked, 1);
  });

  it("continues processing when abortOnBlock is false", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const decisions: Array<{ toolName: string; blocked: boolean }> = [];
    const processor = new GovernanceProcessor(gov, {
      agentName: "lenient-agent",
      owner: "test-team",
      abortOnBlock: false,
      onDecision: (d, tc) => decisions.push({ toolName: tc.toolName, blocked: d.blocked }),
    });

    let aborted = false;
    await processor.processOutputStep(makeArgs(
      [
        makeToolCall("shell_exec", { command: "ls" }),
        makeToolCall("web_search", { query: "safe" }),
      ],
      { onAbort: () => { aborted = true; } },
    ));

    assert.equal(aborted, false); // Should NOT abort
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].blocked, true);
    assert.equal(decisions[1].blocked, false);

    const stats = processor.getStats();
    assert.equal(stats.totalProcessed, 2);
    assert.equal(stats.totalBlocked, 1);
    assert.equal(stats.totalAllowed, 1);
  });

  it("skips steps with no tool calls", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const processor = new GovernanceProcessor(gov, {
      agentName: "text-agent",
      owner: "test-team",
    });

    await processor.processOutputStep(makeArgs([]));

    // Should not have registered (no tool calls to process)
    assert.equal(processor.getAgentId(), null);
    assert.equal(processor.getStats().totalProcessed, 0);
  });

  it("tracks per-tool statistics", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const processor = new GovernanceProcessor(gov, {
      agentName: "stats-agent",
      owner: "test-team",
      abortOnBlock: false,
    });

    // Process multiple steps
    await processor.processOutputStep(makeArgs(
      [makeToolCall("web_search"), makeToolCall("shell_exec")],
    ));
    await processor.processOutputStep(makeArgs(
      [makeToolCall("web_search"), makeToolCall("crm_update")],
    ));

    const stats = processor.getStats();
    assert.equal(stats.totalProcessed, 4);
    assert.equal(stats.totalAllowed, 3);
    assert.equal(stats.totalBlocked, 1);
    assert.deepEqual(stats.byTool["web_search"], { allowed: 2, blocked: 0 });
    assert.deepEqual(stats.byTool["shell_exec"], { allowed: 0, blocked: 1 });
    assert.deepEqual(stats.byTool["crm_update"], { allowed: 1, blocked: 0 });
  });

  it("supports custom abort messages", async () => {
    const gov = createGovernance({
      rules: [blockTools(["dangerous_tool"])],
    });

    let abortMsg = "";
    const processor = new GovernanceProcessor(gov, {
      agentName: "custom-msg-agent",
      owner: "test-team",
      abortMessage: (decision, tc) =>
        `DENIED: ${tc.toolName} violated rule ${decision.ruleId}`,
    });

    await processor.processOutputStep(makeArgs(
      [makeToolCall("dangerous_tool")],
      { onAbort: (reason) => { abortMsg = reason ?? ""; } },
    ));

    assert.ok(abortMsg.startsWith("DENIED:"));
    assert.ok(abortMsg.includes("dangerous_tool"));
  });

  it("logs audit events for all enforcement decisions", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const processor = new GovernanceProcessor(gov, {
      agentName: "audit-agent",
      owner: "test-team",
      abortOnBlock: false,
    });

    await processor.processOutputStep(makeArgs(
      [makeToolCall("web_search"), makeToolCall("shell_exec")],
    ));

    // Check audit trail
    const events = await gov.audit.query({});
    // 1 registration event + 2 enforcement events
    assert.equal(events.length, 3);

    const policyEvents = events.filter((e) => e.eventType === "policy_evaluation");
    assert.equal(policyEvents.length, 2);
  });

  it("supports token budget enforcement via sessionTokenTracker", async () => {
    let tokenCount = 95000;
    const gov = createGovernance({
      rules: [tokenBudget(100000)],
    });

    const processor = new GovernanceProcessor(gov, {
      agentName: "budget-agent",
      owner: "test-team",
      sessionTokenTracker: () => tokenCount,
      abortOnBlock: false,
    });

    // First call: under budget
    await processor.processOutputStep(makeArgs([makeToolCall("web_search")]));
    assert.equal(processor.getStats().totalAllowed, 1);

    // Simulate token usage increase
    tokenCount = 105000;

    // Second call: over budget
    await processor.processOutputStep(makeArgs([makeToolCall("web_search")]));
    assert.equal(processor.getStats().totalBlocked, 1);
  });

  it("retryOnBlock sends retry=true on first attempts", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    let abortOptions: MastraAbortOptions<{ violations: unknown[] }> | undefined;
    let abortReason = "";

    const processor = new GovernanceProcessor(gov, {
      agentName: "retry-agent",
      owner: "test-team",
      retryOnBlock: true,
      maxRetries: 2,
    });

    // First attempt (retryCount=0) — should retry
    await processor.processOutputStep(makeArgs(
      [makeToolCall("shell_exec")],
      {
        retryCount: 0,
        onAbort: (reason, options) => {
          abortReason = reason ?? "";
          abortOptions = options as MastraAbortOptions<{ violations: unknown[] }>;
        },
      },
    ));

    assert.ok(abortReason.includes("different approach"));
    assert.equal(abortOptions?.retry, true);
    assert.ok(Array.isArray(abortOptions?.metadata?.violations));
  });

  it("retryOnBlock hard-blocks after maxRetries", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    let abortOptions: MastraAbortOptions<{ violations: unknown[] }> | undefined;

    const processor = new GovernanceProcessor(gov, {
      agentName: "max-retry-agent",
      owner: "test-team",
      retryOnBlock: true,
      maxRetries: 2,
    });

    // At maxRetries (retryCount=2) — should hard-block
    await processor.processOutputStep(makeArgs(
      [makeToolCall("shell_exec")],
      {
        retryCount: 2,
        onAbort: (_reason, options) => {
          abortOptions = options as MastraAbortOptions<{ violations: unknown[] }>;
        },
      },
    ));

    assert.equal(abortOptions?.retry, false);
  });

  it("logToolResult creates audit events", async () => {
    const gov = createGovernance({});

    const processor = new GovernanceProcessor(gov, {
      agentName: "log-agent",
      owner: "test-team",
    });

    // Force registration
    await processor.processOutputStep(makeArgs([makeToolCall("web_search")]));

    const event = await processor.logToolResult("web_search", "success", {
      resultCount: 10,
    });

    assert.equal(event.eventType, "tool_call");
    assert.equal(event.outcome, "success");
    assert.equal(event.severity, "info");
  });

  it("resetStats clears all counters", async () => {
    const gov = createGovernance({});

    const processor = new GovernanceProcessor(gov, {
      agentName: "reset-agent",
      owner: "test-team",
    });

    await processor.processOutputStep(makeArgs([makeToolCall("web_search")]));

    assert.equal(processor.getStats().totalProcessed, 1);

    processor.resetStats();
    const stats = processor.getStats();
    assert.equal(stats.totalProcessed, 0);
    assert.equal(stats.totalAllowed, 0);
    assert.equal(stats.totalBlocked, 0);
    assert.deepEqual(stats.byTool, {});
  });
});
