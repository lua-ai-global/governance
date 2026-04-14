import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  maskOutputPattern,
  outputPattern,
} from "../index";
import { enforcePostprocessStream } from "./pre-post-stream";
import { GovernanceBlockedError } from "./outcome-handler";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "stream-test", framework: "vercel-ai", owner: "t",
  });
  return { gov, agentId: id };
}

async function* toStream<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

interface TextChunk { text: string; meta?: string }
const extractText = (c: TextChunk) => c.text;
const buildMasked = (orig: TextChunk, masked: string): TextChunk => ({ ...orig, text: masked });

describe("pre-post-stream — buffered mode", () => {
  it("allow: flushes all chunks unchanged after scanning the combined text", async () => {
    const { gov, agentId } = await registerAgent();
    const chunks: TextChunk[] = [
      { text: "hello " },
      { text: "world" },
    ];

    const out = await collect(
      enforcePostprocessStream(gov, toStream(chunks), {
        agentId,
        streamMode: "buffered",
        extractText,
      }),
    );

    assert.equal(out.length, 2);
    assert.equal(out[0].text, "hello ");
    assert.equal(out[1].text, "world");
  });

  it("block: throws GovernanceBlockedError after source completes", async () => {
    const { gov, agentId } = await registerAgent([
      outputPattern("SECRET", "g", "contains secret"),
    ]);
    const chunks: TextChunk[] = [{ text: "SEC" }, { text: "RET" }];

    await assert.rejects(
      async () => {
        await collect(
          enforcePostprocessStream(gov, toStream(chunks), {
            agentId, streamMode: "buffered", extractText,
          }),
        );
      },
      GovernanceBlockedError,
    );
  });

  it("mask: emits a single replacement chunk with masked text", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const chunks: TextChunk[] = [
      { text: "ssn is 123-" },
      { text: "45-6789 ok" },
    ];

    const out = await collect(
      enforcePostprocessStream(gov, toStream(chunks), {
        agentId,
        streamMode: "buffered",
        extractText,
        buildMaskedChunk: buildMasked,
      }),
    );

    assert.equal(out.length, 1);
    assert.ok(!/123-45-6789/.test(out[0].text), `expected masked, got: ${out[0].text}`);
  });
});

describe("pre-post-stream — per-chunk mode", () => {
  it("allow: each chunk passes through", async () => {
    const { gov, agentId } = await registerAgent();
    const chunks: TextChunk[] = [{ text: "hi" }, { text: " there" }];
    const out = await collect(
      enforcePostprocessStream(gov, toStream(chunks), {
        agentId, streamMode: "per-chunk", extractText,
      }),
    );
    assert.deepEqual(out.map((c) => c.text), ["hi", " there"]);
  });

  it("per-chunk scans each chunk in isolation (cross-chunk pattern NOT caught)", async () => {
    const { gov, agentId } = await registerAgent([
      outputPattern("SECRET", "g", "contains secret"),
    ]);
    // SECRET is split across two chunks — per-chunk mode misses it.
    const chunks: TextChunk[] = [{ text: "SEC" }, { text: "RET" }];
    const out = await collect(
      enforcePostprocessStream(gov, toStream(chunks), {
        agentId, streamMode: "per-chunk", extractText,
      }),
    );
    assert.equal(out.length, 2); // no block — this is the per-chunk tradeoff
  });

  it("per-chunk: catches a pattern wholly contained in one chunk", async () => {
    const { gov, agentId } = await registerAgent([
      outputPattern("SECRET", "g"),
    ]);
    const chunks: TextChunk[] = [{ text: "before" }, { text: "SECRET here" }];
    await assert.rejects(
      async () => {
        await collect(
          enforcePostprocessStream(gov, toStream(chunks), {
            agentId, streamMode: "per-chunk", extractText,
          }),
        );
      },
      GovernanceBlockedError,
    );
  });

  it("per-chunk: masks each chunk's text independently", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const chunks: TextChunk[] = [
      { text: "clean start " },
      { text: "123-45-6789 leak" },
    ];
    const out = await collect(
      enforcePostprocessStream(gov, toStream(chunks), {
        agentId, streamMode: "per-chunk", extractText,
        buildMaskedChunk: buildMasked,
      }),
    );
    assert.equal(out[0].text, "clean start ");
    assert.ok(!/123-45-6789/.test(out[1].text), `expected masked, got: ${out[1].text}`);
  });
});

describe("pre-post-stream — sliding mode", () => {
  it("catches cross-chunk pattern that per-chunk misses", async () => {
    const { gov, agentId } = await registerAgent([
      outputPattern("SECRET", "g"),
    ]);
    // SECRET split across boundaries; sliding with lookback >= 1 catches it.
    const chunks: TextChunk[] = [
      { text: "a " },
      { text: "SEC" },
      { text: "RET" },
      { text: " end" },
    ];
    await assert.rejects(
      async () => {
        await collect(
          enforcePostprocessStream(gov, toStream(chunks), {
            agentId,
            streamMode: "sliding",
            streamLookbackChunks: 2,
            extractText,
          }),
        );
      },
      GovernanceBlockedError,
    );
  });

  it("allow: flushes chunks with lookback delay, preserving order", async () => {
    const { gov, agentId } = await registerAgent();
    const chunks: TextChunk[] = [
      { text: "a" }, { text: "b" }, { text: "c" }, { text: "d" },
    ];
    const out = await collect(
      enforcePostprocessStream(gov, toStream(chunks), {
        agentId,
        streamMode: "sliding",
        streamLookbackChunks: 2,
        extractText,
      }),
    );
    assert.deepEqual(out.map((c) => c.text), ["a", "b", "c", "d"]);
  });

  it("tail drain: final window is scanned after source ends", async () => {
    const { gov, agentId } = await registerAgent([
      outputPattern("END", "g"),
    ]);
    // "END" only appears at the very end of the stream — inside the
    // still-held lookback window when source closes.
    const chunks: TextChunk[] = [
      { text: "start " },
      { text: "EN" },
      { text: "D" },
    ];
    await assert.rejects(
      async () => {
        await collect(
          enforcePostprocessStream(gov, toStream(chunks), {
            agentId,
            streamMode: "sliding",
            streamLookbackChunks: 3,
            extractText,
          }),
        );
      },
      GovernanceBlockedError,
    );
  });

  it("char-based lookback: flushes when chars exceed threshold", async () => {
    const { gov, agentId } = await registerAgent();
    const chunks: TextChunk[] = [
      { text: "aaaaa" }, { text: "bbbbb" }, { text: "ccccc" },
    ];
    const out = await collect(
      enforcePostprocessStream(gov, toStream(chunks), {
        agentId,
        streamMode: "sliding",
        streamLookbackChunks: 99,  // not the constraint
        streamLookbackChars: 5,    // chars drive flushing
        extractText,
      }),
    );
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((c) => c.text), ["aaaaa", "bbbbb", "ccccc"]);
  });
});

describe("pre-post-stream — default mode", () => {
  it("default is buffered (safest)", async () => {
    const { gov, agentId } = await registerAgent([
      outputPattern("SECRET", "g"),
    ]);
    // Cross-chunk pattern — only buffered/sliding catch it. If default were
    // per-chunk, this would pass through.
    const chunks: TextChunk[] = [{ text: "SEC" }, { text: "RET" }];
    await assert.rejects(
      async () => {
        await collect(
          enforcePostprocessStream(gov, toStream(chunks), {
            agentId,
            extractText,
          }),
        );
      },
      GovernanceBlockedError,
    );
  });
});
