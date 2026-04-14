import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  maskOutputPattern,
  outputPattern,
} from "../index";
import { buildWrapStream } from "./vercel-ai-stream";
import type { VercelStreamPart, VercelStreamResult } from "./vercel-ai-stream";
import { GovernanceBlockedError } from "./outcome-handler";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "vercel-stream-test", framework: "vercel-ai", owner: "t",
  });
  return { gov, agentId: id };
}

function streamOf(parts: VercelStreamPart[]): ReadableStream<VercelStreamPart> {
  return new ReadableStream<VercelStreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<VercelStreamPart>): Promise<VercelStreamPart[]> {
  const out: VercelStreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

async function collectOrThrow(stream: ReadableStream<VercelStreamPart>): Promise<VercelStreamPart[]> {
  // Read via async iterator if available, otherwise manual — errors from
  // controller.error(...) surface as reader.read() rejections.
  const out: VercelStreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("vercel-ai-stream — buffered (default)", () => {
  it("allow: passes text-delta + finish parts through", async () => {
    const { gov, agentId } = await registerAgent();
    const wrap = buildWrapStream(gov, { agentId });
    const source: VercelStreamResult = {
      stream: streamOf([
        { type: "text-delta", delta: "hello " },
        { type: "text-delta", delta: "world" },
        { type: "finish", finishReason: "stop" } as VercelStreamPart,
      ]),
    };

    const { stream } = await wrap({ doStream: async () => source, params: {} });
    const parts = await collect(stream);

    assert.equal(parts.length, 3);
    assert.equal(parts[0].delta, "hello ");
    assert.equal(parts[1].delta, "world");
    assert.equal(parts[2].type, "finish");
  });

  it("block: throws on the stream when a cross-chunk pattern hits", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const wrap = buildWrapStream(gov, { agentId });
    const source: VercelStreamResult = {
      stream: streamOf([
        { type: "text-delta", delta: "SEC" },
        { type: "text-delta", delta: "RET" },
        { type: "finish" } as VercelStreamPart,
      ]),
    };

    const { stream } = await wrap({ doStream: async () => source, params: {} });
    await assert.rejects(() => collectOrThrow(stream), GovernanceBlockedError);
  });

  it("mask: collapses text to a single masked delta and preserves finish", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const wrap = buildWrapStream(gov, { agentId });
    const source: VercelStreamResult = {
      stream: streamOf([
        { type: "text-delta", delta: "ssn is 123-" },
        { type: "text-delta", delta: "45-6789 ok" },
        { type: "finish" } as VercelStreamPart,
      ]),
    };

    const { stream } = await wrap({ doStream: async () => source, params: {} });
    const parts = await collect(stream);

    const textParts = parts.filter((p) => p.type === "text-delta");
    assert.ok(textParts.length >= 1);
    const fullText = textParts.map((p) => p.delta).join("");
    assert.ok(!/123-45-6789/.test(fullText), `expected masked, got: ${fullText}`);
    // finish still emitted
    assert.ok(parts.some((p) => p.type === "finish"));
  });
});

describe("vercel-ai-stream — per-chunk mode", () => {
  it("per-chunk: masks each chunk independently, preserves part count", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const wrap = buildWrapStream(gov, { agentId, streamMode: "per-chunk" });
    const source: VercelStreamResult = {
      stream: streamOf([
        { type: "text-delta", delta: "clean " },
        { type: "text-delta", delta: "123-45-6789 leak" },
        { type: "finish" } as VercelStreamPart,
      ]),
    };

    const { stream } = await wrap({ doStream: async () => source, params: {} });
    const parts = await collect(stream);
    const textParts = parts.filter((p) => p.type === "text-delta");
    assert.equal(textParts.length, 2);
    assert.equal(textParts[0].delta, "clean ");
    assert.ok(!/123-45-6789/.test(textParts[1].delta ?? ""));
  });

  it("per-chunk: misses cross-chunk pattern (documented tradeoff)", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const wrap = buildWrapStream(gov, { agentId, streamMode: "per-chunk" });
    const source: VercelStreamResult = {
      stream: streamOf([
        { type: "text-delta", delta: "SEC" },
        { type: "text-delta", delta: "RET" },
      ]),
    };

    const { stream } = await wrap({ doStream: async () => source, params: {} });
    const parts = await collect(stream);
    assert.equal(parts.length, 2); // no block — the tradeoff
  });
});

describe("vercel-ai-stream — sliding mode", () => {
  it("sliding: catches cross-chunk patterns that per-chunk misses", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const wrap = buildWrapStream(gov, {
      agentId,
      streamMode: "sliding",
      streamLookbackChunks: 2,
    });
    const source: VercelStreamResult = {
      stream: streamOf([
        { type: "text-delta", delta: "a " },
        { type: "text-delta", delta: "SEC" },
        { type: "text-delta", delta: "RET" },
        { type: "text-delta", delta: " end" },
      ]),
    };

    const { stream } = await wrap({ doStream: async () => source, params: {} });
    await assert.rejects(() => collectOrThrow(stream), GovernanceBlockedError);
  });
});

describe("vercel-ai-stream — flags", () => {
  it("postprocess: false skips scanning entirely", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const wrap = buildWrapStream(gov, { agentId, postprocess: false });
    const source: VercelStreamResult = {
      stream: streamOf([
        { type: "text-delta", delta: "SECRET here" },
      ]),
    };

    const { stream } = await wrap({ doStream: async () => source, params: {} });
    const parts = await collect(stream);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].delta, "SECRET here");
  });
});
