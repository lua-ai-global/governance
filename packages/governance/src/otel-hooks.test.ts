import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOtelHooks } from "./otel-hooks";

describe("OTel Hooks", () => {
  it("creates hooks with default config", () => {
    const hooks = createOtelHooks();
    assert.ok(hooks.toSpan);
    assert.ok(hooks.enforcementSpan);
  });

  it("converts governance event to span", () => {
    const hooks = createOtelHooks();
    const span = hooks.toSpan({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      agentId: "agent-1",
      detail: { blocked: true, outcome: "block", ruleId: "rule-1", tool: "shell_exec" },
    });

    assert.equal(span.operationName, "governance.enforcement");
    assert.equal(span.kind, "internal");
    assert.equal(span.status, "error"); // blocked = error status
    assert.ok(span.traceId.length === 64); // 32 bytes hex
    assert.ok(span.spanId.length === 32); // 16 bytes hex
    assert.equal(span.attributes["governance.event.type"], "enforcement");
    assert.equal(span.attributes["governance.agent.id"], "agent-1");
    assert.equal(span.attributes["governance.blocked"], true);
    assert.equal(span.attributes["governance.outcome"], "block");
    assert.equal(span.attributes["governance.tool"], "shell_exec");
  });

  it("produces ok status for allowed actions", () => {
    const hooks = createOtelHooks();
    const span = hooks.toSpan({
      type: "enforcement",
      timestamp: new Date().toISOString(),
      detail: { blocked: false, outcome: "allow" },
    });
    assert.equal(span.status, "ok");
  });

  it("uses custom service name", () => {
    const hooks = createOtelHooks({ serviceName: "my-app" });
    const span = hooks.toSpan({ type: "registration", timestamp: new Date().toISOString(), detail: {} });
    assert.equal(span.attributes["service.name"], "my-app");
  });

  it("uses custom attribute mapper", () => {
    const hooks = createOtelHooks({
      attributeMapper: (event) => ({ "custom.key": event.type }),
    });
    const span = hooks.toSpan({ type: "kill", timestamp: new Date().toISOString(), detail: {} });
    assert.equal(span.attributes["custom.key"], "kill");
  });

  it("creates enforcement span via convenience method", () => {
    const hooks = createOtelHooks();
    const span = hooks.enforcementSpan({
      blocked: false,
      outcome: "allow",
      agentId: "bot-1",
      tool: "search",
      rulesEvaluated: 5,
    });
    assert.equal(span.operationName, "governance.enforcement");
    assert.equal(span.attributes["governance.agent.id"], "bot-1");
    assert.equal(span.attributes["governance.rules_evaluated"], 5);
  });

  it("handles missing optional fields gracefully", () => {
    const hooks = createOtelHooks();
    const span = hooks.toSpan({ type: "audit", timestamp: new Date().toISOString(), detail: {} });
    assert.equal(span.operationName, "governance.audit");
    assert.ok(!("governance.agent.id" in span.attributes));
  });

  it("generates unique trace and span IDs", () => {
    const hooks = createOtelHooks();
    const span1 = hooks.toSpan({ type: "enforcement", timestamp: new Date().toISOString(), detail: {} });
    const span2 = hooks.toSpan({ type: "enforcement", timestamp: new Date().toISOString(), detail: {} });
    assert.notEqual(span1.traceId, span2.traceId);
    assert.notEqual(span1.spanId, span2.spanId);
  });
});

describe("OTel GenAI semantic conventions (0.12)", () => {
  it("emits gen_ai.* attributes when conventions: 'gen_ai'", () => {
    const hooks = createOtelHooks({ conventions: "gen_ai" });
    const span = hooks.toSpan({
      type: "policy_evaluation",
      timestamp: new Date().toISOString(),
      agentId: "a-1",
      detail: {
        blocked: false,
        outcome: "allow",
        ruleId: "r-1",
        system: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 120,
        outputTokens: 340,
        finishReason: "end_turn",
        tool: "search",
        toolCallId: "tc_abc",
      },
    });

    // Operation name adopts GenAI form
    assert.equal(span.operationName, "gen_ai.policy.evaluate");
    // GenAI attributes
    assert.equal(span.attributes["gen_ai.system"], "anthropic");
    assert.equal(span.attributes["gen_ai.request.model"], "claude-sonnet-4-6");
    assert.equal(span.attributes["gen_ai.usage.input_tokens"], 120);
    assert.equal(span.attributes["gen_ai.usage.output_tokens"], 340);
    assert.equal(span.attributes["gen_ai.response.finish_reasons"], "end_turn");
    assert.equal(span.attributes["gen_ai.tool.name"], "search");
    assert.equal(span.attributes["gen_ai.tool.call.id"], "tc_abc");
    // Governance attributes remain — policy decisions have no GenAI equivalent
    assert.equal(span.attributes["governance.rule.id"], "r-1");
    assert.equal(span.attributes["governance.outcome"], "allow");
  });

  it("'both' mode keeps legacy operation name and adds gen_ai attributes", () => {
    const hooks = createOtelHooks({ conventions: "both" });
    const span = hooks.toSpan({
      type: "action_outcome",
      timestamp: new Date().toISOString(),
      detail: { tool: "send_email", tokensUsed: 50 },
    });
    // Back-compat: op name is still governance.*
    assert.equal(span.operationName, "governance.action_outcome");
    // GenAI attrs emitted
    assert.equal(span.attributes["gen_ai.tool.name"], "send_email");
    assert.equal(span.attributes["gen_ai.usage.output_tokens"], 50);
    // Governance attrs emitted
    assert.equal(span.attributes["governance.tool"], "send_email");
  });

  it("'governance' mode emits no gen_ai.* attributes", () => {
    const hooks = createOtelHooks({ conventions: "governance" });
    const span = hooks.toSpan({
      type: "policy_evaluation",
      timestamp: new Date().toISOString(),
      detail: { model: "claude-haiku-4-5", inputTokens: 10 },
    });
    assert.equal(span.operationName, "governance.policy_evaluation");
    assert.ok(
      !Object.keys(span.attributes).some((k) => k.startsWith("gen_ai.")),
      "no gen_ai.* attributes in 'governance' mode",
    );
  });

  it("events with no GenAI analogue keep governance.* operation name even under 'gen_ai'", () => {
    const hooks = createOtelHooks({ conventions: "gen_ai" });
    const span = hooks.toSpan({
      type: "kill",
      timestamp: new Date().toISOString(),
      detail: { reason: "emergency" },
    });
    assert.equal(span.operationName, "governance.kill");
  });
});
