import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
  outputPattern,
} from "../index";
import { wrapChatModel } from "./langchain-model";
import type { LangChainMessage } from "./langchain-model";
import type { LangChainStreamingChatModel } from "./langchain-stream";
import { GovernanceBlockedError } from "./outcome-handler";

class FakeHumanMessage implements LangChainMessage {
  constructor(public content: string) {}
  _getType() { return "human"; }
}

class FakeAIChunk implements LangChainMessage {
  constructor(public content: string) {}
  _getType() { return "ai"; }
}

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "langchain-stream-test", framework: "langchain", owner: "t",
  });
  return { gov, agentId: id };
}

function streamingModel(chunks: string[]): LangChainStreamingChatModel & { received?: unknown } {
  const m: LangChainStreamingChatModel & { received?: unknown } = {
    invoke: async () => new FakeAIChunk(chunks.join("")),
    stream: async function* (input) {
      m.received = input;
      for (const c of chunks) yield new FakeAIChunk(c);
    },
  };
  return m;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("langchain-stream — preprocess", () => {
  it("block: throws before upstream stream starts", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    const model = streamingModel(["won't", "happen"]);
    const guarded = wrapChatModel(model, gov, { agentId });

    await assert.rejects(async () => {
      const s = await guarded.stream!([new FakeHumanMessage("do forbidden thing")]);
      await collect(s);
    }, GovernanceBlockedError);
    assert.equal(model.received, undefined);
  });

  it("allow: forwards input to underlying stream", async () => {
    const { gov, agentId } = await registerAgent();
    const model = streamingModel(["hi"]);
    const guarded = wrapChatModel(model, gov, { agentId });

    const s = await guarded.stream!([new FakeHumanMessage("hello")]);
    await collect(s);
    assert.ok(Array.isArray(model.received));
  });
});

describe("langchain-stream — postprocess", () => {
  it("block: cross-chunk pattern throws in default buffered mode", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const model = streamingModel(["SEC", "RET"]);
    const guarded = wrapChatModel(model, gov, { agentId });

    await assert.rejects(async () => {
      const s = await guarded.stream!([new FakeHumanMessage("hi")]);
      await collect(s);
    }, GovernanceBlockedError);
  });

  it("mask: replaces chunk content with masked text", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const model = streamingModel(["ssn 123-", "45-6789 leak"]);
    const guarded = wrapChatModel(model, gov, { agentId });

    const s = await guarded.stream!([new FakeHumanMessage("hi")]);
    const chunks = await collect(s);
    const combined = chunks.map((c) => c.content as string).join("");
    assert.ok(!/123-45-6789/.test(combined), `expected masked, got: ${combined}`);
  });

  it("per-chunk mode: masks each chunk independently", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const model = streamingModel(["clean ", "123-45-6789 leak"]);
    const guarded = wrapChatModel(model, gov, {
      agentId, streamMode: "per-chunk",
    });

    const s = await guarded.stream!([new FakeHumanMessage("hi")]);
    const chunks = await collect(s);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].content, "clean ");
    assert.ok(!/123-45-6789/.test(chunks[1].content as string));
  });
});

describe("langchain-stream — sliding mode", () => {
  it("catches cross-chunk patterns per-chunk misses", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const model = streamingModel(["a ", "SEC", "RET", " end"]);
    const guarded = wrapChatModel(model, gov, {
      agentId, streamMode: "sliding", streamLookbackChunks: 2,
    });

    await assert.rejects(async () => {
      const s = await guarded.stream!([new FakeHumanMessage("hi")]);
      await collect(s);
    }, GovernanceBlockedError);
  });
});

describe("langchain-stream — flags & fallbacks", () => {
  it("postprocess: false skips scanning on stream", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const model = streamingModel(["SECRET here"]);
    const guarded = wrapChatModel(model, gov, { agentId, postprocess: false });

    const s = await guarded.stream!([new FakeHumanMessage("hi")]);
    const chunks = await collect(s);
    assert.equal(chunks[0].content, "SECRET here");
  });

  it("model without .stream does not gain a stream override", async () => {
    const { gov, agentId } = await registerAgent();
    const nonStreaming = {
      invoke: async () => new FakeAIChunk("x"),
    };
    const guarded = wrapChatModel(nonStreaming, gov, { agentId });
    assert.equal((guarded as LangChainStreamingChatModel).stream, undefined);
  });
});
