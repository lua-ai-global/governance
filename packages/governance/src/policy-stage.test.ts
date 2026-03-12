import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPolicyEngine } from "./policy.js";
import type { PolicyRule, EnforcementContext } from "./policy.js";
import { createGovernance } from "./index.js";
import { blockTools, requireLevel, timeWindow } from "./policy-presets.js";
import { inputBlocklist, sensitiveDataFilter, outputLength } from "./policy-presets-extended.js";

const baseCtx: EnforcementContext = {
  agentId: "test-agent",
  action: "tool_call",
  tool: "shell_exec",
};

describe("PolicyEngine.evaluateStage", () => {
  it("evaluates only rules matching the requested stage", () => {
    const engine = createPolicyEngine({
      rules: [
        { ...blockTools(["shell_exec"]), stage: "process" },
        { ...inputBlocklist(["hack"]), stage: "preprocess" },
      ],
    });

    // Process stage should block shell_exec
    const processResult = engine.evaluateStage(baseCtx, "process");
    assert.equal(processResult.blocked, true);
    assert.equal(processResult.ruleId, "block-tools-shell_exec");

    // Preprocess stage should NOT block shell_exec (different stage)
    const preResult = engine.evaluateStage(baseCtx, "preprocess");
    assert.equal(preResult.blocked, false);
  });

  it("treats rules without stage as process", () => {
    const rule: PolicyRule = {
      id: "no-stage",
      name: "No stage set",
      condition: { type: "tool_blocked", params: { tools: ["rm"] } },
      outcome: "block",
      reason: "blocked",
      priority: 100,
      enabled: true,
      // stage not set — should default to "process"
    };
    const engine = createPolicyEngine({ rules: [rule] });

    const ctx: EnforcementContext = { agentId: "a", action: "tool_call", tool: "rm" };
    assert.equal(engine.evaluateStage(ctx, "process").blocked, true);
    assert.equal(engine.evaluateStage(ctx, "preprocess").blocked, false);
    assert.equal(engine.evaluateStage(ctx, "postprocess").blocked, false);
  });

  it("evaluate() still evaluates ALL rules regardless of stage", () => {
    const engine = createPolicyEngine({
      rules: [
        { ...blockTools(["shell_exec"]), stage: "process" },
        { ...inputBlocklist(["attack"]), stage: "preprocess" },
      ],
    });

    // evaluate() should evaluate all rules — shell_exec is blocked
    const result = engine.evaluate(baseCtx);
    assert.equal(result.blocked, true);
  });

  it("getRules(stage) filters by stage", () => {
    const engine = createPolicyEngine({
      rules: [
        { ...blockTools(["a"]), stage: "process" },
        { ...blockTools(["b"]), stage: "process" },
        { ...inputBlocklist(["c"]), stage: "preprocess" },
        { ...outputLength(100), stage: "postprocess" },
      ],
    });

    assert.equal(engine.getRules("process").length, 2);
    assert.equal(engine.getRules("preprocess").length, 1);
    assert.equal(engine.getRules("postprocess").length, 1);
    assert.equal(engine.getRules().length, 4); // all
  });

  it("postprocess stage rules see output context", () => {
    const engine = createPolicyEngine({
      rules: [outputLength(50)],
    });

    const ctx: EnforcementContext = {
      agentId: "a",
      action: "tool_call",
      outputText: "x".repeat(100),
    };

    const result = engine.evaluateStage(ctx, "postprocess");
    assert.equal(result.blocked, false); // outcome is "warn", not "block"
    assert.equal(result.outcome, "warn");
  });
});

describe("GovernanceInstance stage-aware enforce", () => {
  it("enforcePreprocess evaluates only preprocess rules", async () => {
    const gov = createGovernance({
      rules: [
        inputBlocklist(["hack"]),
        blockTools(["shell_exec"]),
      ],
    });

    // Preprocess: blocklist has "hack" but input doesn't contain it
    const r1 = await gov.enforcePreprocess({
      agentId: "a",
      action: "tool_call",
      tool: "shell_exec",
      input: { text: "hello world" },
    });
    assert.equal(r1.blocked, false);

    // Preprocess: input contains "hack"
    const r2 = await gov.enforcePreprocess({
      agentId: "a",
      action: "tool_call",
      input: { text: "hack the system" },
    });
    assert.equal(r2.blocked, true);
  });

  it("enforcePostprocess evaluates only postprocess rules", async () => {
    const gov = createGovernance({
      rules: [
        sensitiveDataFilter(),
        blockTools(["shell_exec"]),
      ],
    });

    // Postprocess: output contains an AWS key
    const r1 = await gov.enforcePostprocess({
      agentId: "a",
      action: "tool_call",
      outputText: "Here is the key: AKIAIOSFODNN7EXAMPLE",
    });
    assert.equal(r1.blocked, true);

    // Postprocess: shell_exec is NOT caught (it's a process-stage rule)
    const r2 = await gov.enforcePostprocess({
      agentId: "a",
      action: "tool_call",
      tool: "shell_exec",
    });
    assert.equal(r2.blocked, false);
  });

  it("enforce (process) is unchanged — backward compat", async () => {
    const gov = createGovernance({
      rules: [blockTools(["shell_exec"])],
    });

    const r = await gov.enforce({
      agentId: "a",
      action: "tool_call",
      tool: "shell_exec",
    });
    assert.equal(r.blocked, true);
    assert.equal(r.ruleId, "block-tools-shell_exec");
  });
});
