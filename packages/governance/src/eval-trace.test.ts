import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTraceCollector, submitTrace } from "./eval-trace";

describe("createTraceCollector", () => {
  it("starts, appends spans, and ends a trace", () => {
    const traces = createTraceCollector();
    const ctx = traces.startTrace("luna", "what closed?", { tenant: "acme" });
    assert.ok(ctx.traceId);
    const spanId = ctx.addSpan({ operation: "tool_call", toolName: "search", success: true });
    assert.ok(spanId);
    const trace = ctx.end("3 deals");
    assert.equal(trace.agentId, "luna");
    assert.equal(trace.output, "3 deals");
    assert.equal(trace.spans.length, 1);
    assert.ok(trace.completedAt);
  });

  it("stores completed traces retrievable by agentId", () => {
    const traces = createTraceCollector();
    traces.startTrace("alice").end();
    traces.startTrace("alice").end();
    traces.startTrace("bob").end();
    assert.equal(traces.getTraces("alice").length, 2);
    assert.equal(traces.getTraces("bob").length, 1);
    assert.equal(traces.traceCount(), 3);
  });

  it("evicts oldest traces once maxTraces is exceeded", () => {
    const traces = createTraceCollector({ maxTraces: 2 });
    const a = traces.startTrace("x").end();
    const b = traces.startTrace("x").end();
    const c = traces.startTrace("x").end();
    const stored = traces.getTraces("x");
    assert.equal(stored.length, 2);
    assert.ok(!stored.find((t) => t.traceId === a.traceId), "oldest should be evicted");
    assert.ok(stored.find((t) => t.traceId === b.traceId));
    assert.ok(stored.find((t) => t.traceId === c.traceId));
  });

  it("end is idempotent — calling twice does not duplicate the trace", () => {
    const traces = createTraceCollector();
    const ctx = traces.startTrace("x");
    ctx.end("first");
    ctx.end("second"); // should be ignored
    const stored = traces.getTraces("x");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].output, "first");
  });

  it("ignores spans added after end()", () => {
    const traces = createTraceCollector();
    const ctx = traces.startTrace("x");
    ctx.addSpan({ operation: "tool_call", success: true });
    const trace = ctx.end();
    const lateSpanId = ctx.addSpan({ operation: "tool_call", success: true });
    assert.equal(lateSpanId, "");
    assert.equal(trace.spans.length, 1);
  });

  it("clear() drops all pending + completed traces", () => {
    const traces = createTraceCollector();
    traces.startTrace("a").end();
    traces.startTrace("b"); // still pending
    traces.clear();
    assert.equal(traces.traceCount(), 0);
    assert.equal(traces.getTraces("a").length, 0);
  });
});

describe("submitTrace (one-shot)", () => {
  it("submits a trace with spans + input + output in a single call", () => {
    const traces = createTraceCollector();
    const trace = submitTrace(traces, {
      agentId: "luna",
      input: "hi",
      output: "hello",
      spans: [
        { operation: "tool_call", toolName: "search", success: true, latencyMs: 100 },
        { operation: "llm_call", model: "claude-opus", success: true, latencyMs: 300 },
      ],
    });
    assert.equal(trace.agentId, "luna");
    assert.equal(trace.input, "hi");
    assert.equal(trace.output, "hello");
    assert.equal(trace.spans.length, 2);
    assert.ok(trace.completedAt);
    assert.equal(traces.getTraces("luna").length, 1);
  });
});
