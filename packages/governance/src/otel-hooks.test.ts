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
