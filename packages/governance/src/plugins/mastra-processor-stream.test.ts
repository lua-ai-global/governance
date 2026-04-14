import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  maskOutputPattern,
  outputPattern,
} from "../index";
import { GovernanceProcessor } from "./mastra-processor";
import type {
  MastraStreamChunk,
  ProcessOutputStreamArgs,
} from "./mastra-processor";

type AbortCalls = Array<{ reason?: string; options?: unknown }>;
function makeAbort(calls: AbortCalls): ProcessOutputStreamArgs["abort"] {
  return ((reason?: string, options?: unknown) => {
    calls.push({ reason, options });
  }) as ProcessOutputStreamArgs["abort"];
}

function textPart(text: string): MastraStreamChunk {
  return { type: "text-delta", payload: { text } };
}

function makeArgs(
  part: MastraStreamChunk,
  abortCalls: AbortCalls,
  state: Record<string, unknown> = {},
): ProcessOutputStreamArgs {
  return {
    part,
    streamParts: [],
    state,
    abort: makeAbort(abortCalls),
  };
}

describe("mastra-processor — processOutputStream — per-chunk (default)", () => {
  it("allow: returns the chunk unchanged", async () => {
    const gov = createGovernance({ rules: [] });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
    });

    const calls: AbortCalls = [];
    const out = await proc.processOutputStream(makeArgs(textPart("hello"), calls));
    assert.ok(out);
    assert.equal(out.payload?.text, "hello");
    assert.equal(calls.length, 0);
  });

  it("block: calls args.abort with governance reason", async () => {
    const gov = createGovernance({
      rules: [outputPattern("SECRET", "g", "contains secret")],
    });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
    });

    const calls: AbortCalls = [];
    await proc.processOutputStream(makeArgs(textPart("SECRET here"), calls));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].reason?.includes("GOVERNANCE"));
  });

  it("mask: returns chunk with masked text in payload", async () => {
    const gov = createGovernance({
      rules: [maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g")],
    });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
    });

    const calls: AbortCalls = [];
    const out = await proc.processOutputStream(makeArgs(textPart("ssn 123-45-6789 leak"), calls));
    assert.ok(out);
    assert.ok(
      !/123-45-6789/.test(out.payload?.text ?? ""),
      `expected masked, got: ${out.payload?.text}`,
    );
    assert.equal(calls.length, 0);
  });

  it("non-text chunks pass through untouched", async () => {
    const gov = createGovernance({ rules: [outputPattern("SECRET", "g")] });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
    });

    const calls: AbortCalls = [];
    const nonText: MastraStreamChunk = { type: "tool-call", payload: { toolName: "x" } };
    const out = await proc.processOutputStream(makeArgs(nonText, calls));
    assert.equal(out, nonText);
    assert.equal(calls.length, 0);
  });
});

describe("mastra-processor — processOutputStream — sliding mode", () => {
  it("catches cross-chunk patterns by scanning the rolling buffer", async () => {
    const gov = createGovernance({ rules: [outputPattern("SECRET", "g")] });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
      streamMode: "sliding", streamLookbackChunks: 3,
    });

    const calls: AbortCalls = [];
    const state: Record<string, unknown> = {};
    // SECRET split across two chunks — per-chunk would miss it.
    await proc.processOutputStream(makeArgs(textPart("SEC"), calls, state));
    await proc.processOutputStream(makeArgs(textPart("RET"), calls, state));
    assert.equal(calls.length, 1, "expected abort on second chunk");
  });

  it("trims the rolling buffer once it exceeds lookback", async () => {
    const gov = createGovernance({ rules: [] });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
      streamMode: "sliding",
      streamLookbackChunks: 2,
      streamLookbackChars: 10,
    });

    const calls: AbortCalls = [];
    const state: Record<string, unknown> = {};
    for (const s of ["aaaaa", "bbbbb", "ccccc", "ddddd"]) {
      await proc.processOutputStream(makeArgs(textPart(s), calls, state));
    }
    // Buffer should be bounded by lookbackChars (10).
    const buf = state.slidingBuffer as string | undefined;
    assert.ok(buf != null);
    assert.ok(buf!.length <= 10, `expected <=10, got ${buf!.length}`);
  });
});

describe("mastra-processor — processOutputStream — buffered mode", () => {
  it("suppresses text parts (drops them) so processOutputResult handles scanning", async () => {
    const gov = createGovernance({ rules: [] });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
      streamMode: "buffered",
    });
    const calls: AbortCalls = [];
    const out = await proc.processOutputStream(makeArgs(textPart("hello"), calls));
    assert.equal(out, null);
  });

  it("passes non-text parts through in buffered mode", async () => {
    const gov = createGovernance({ rules: [] });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
      streamMode: "buffered",
    });
    const calls: AbortCalls = [];
    const part: MastraStreamChunk = { type: "finish", payload: { finishReason: "stop" } };
    const out = await proc.processOutputStream(makeArgs(part, calls));
    assert.equal(out, part);
  });
});

describe("mastra-processor — skipStreamPostprocess flag", () => {
  it("returns chunk untouched when skipStreamPostprocess is true", async () => {
    const gov = createGovernance({ rules: [outputPattern("SECRET", "g")] });
    const proc = new GovernanceProcessor(gov, {
      agentName: "t", owner: "t", framework: "mastra",
      skipStreamPostprocess: true,
    });
    const calls: AbortCalls = [];
    const out = await proc.processOutputStream(makeArgs(textPart("SECRET here"), calls));
    assert.ok(out);
    assert.equal(out.payload?.text, "SECRET here");
    assert.equal(calls.length, 0);
  });
});
