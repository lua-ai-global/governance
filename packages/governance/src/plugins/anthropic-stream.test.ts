import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
  outputPattern,
} from "../index";
import { createGovernedMessageStream } from "./anthropic-stream";
import type {
  AnthropicStreamEvent,
  AnthropicStreamParams,
} from "./anthropic-stream";
import { GovernanceBlockedError } from "./outcome-handler";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "anthropic-stream-test", framework: "anthropic", owner: "t",
  });
  return { gov, agentId: id };
}

/** Build a fake streamFn that yields the given events. */
function fakeStream(events: AnthropicStreamEvent[]) {
  return async function* (_params: AnthropicStreamParams) {
    for (const ev of events) yield ev;
  };
}

function textDelta(text: string): AnthropicStreamEvent {
  return { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("anthropic-stream — preprocess", () => {
  it("block: throws before streamFn is called", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    let called = false;
    const stream = fakeStream([textDelta("won't happen")]);
    const wrapped = (params: AnthropicStreamParams) => {
      called = true;
      return stream(params);
    };
    const governed = createGovernedMessageStream(wrapped, gov, { agentId });

    await assert.rejects(async () => {
      const iter = governed({
        model: "claude-sonnet-4-5", max_tokens: 100,
        messages: [{ role: "user", content: "do forbidden stuff" }],
      });
      await collect(iter);
    }, GovernanceBlockedError);
    assert.equal(called, false);
  });

  it("allow: forwards unmodified params to underlying stream", async () => {
    const { gov, agentId } = await registerAgent();
    let seen: AnthropicStreamParams | null = null;
    const wrapped = async function* (p: AnthropicStreamParams) {
      seen = p;
      yield textDelta("hello");
    };
    const governed = createGovernedMessageStream(wrapped, gov, { agentId });

    await collect(governed({
      model: "claude-sonnet-4-5", max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }));
    assert.ok(seen);
    assert.equal(seen!.messages[0].content, "hi");
  });
});

describe("anthropic-stream — postprocess", () => {
  it("block: throws on cross-chunk pattern in buffered mode", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const stream = fakeStream([
      textDelta("SEC"),
      textDelta("RET"),
      { type: "message_stop" },
    ]);
    const governed = createGovernedMessageStream(stream, gov, { agentId });

    await assert.rejects(async () => {
      await collect(governed({
        model: "claude-sonnet-4-5", max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }));
    }, GovernanceBlockedError);
  });

  it("mask: replaces text_delta events with masked content", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const stream = fakeStream([
      textDelta("ssn is 123-"),
      textDelta("45-6789"),
      { type: "message_stop" },
    ]);
    const governed = createGovernedMessageStream(stream, gov, { agentId });

    const events = await collect(governed({
      model: "claude-sonnet-4-5", max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }));

    const textParts = events.filter((e) => e.type === "content_block_delta");
    const combined = textParts.map((e) => e.delta?.text ?? "").join("");
    assert.ok(!/123-45-6789/.test(combined), `expected masked, got: ${combined}`);
    assert.ok(events.some((e) => e.type === "message_stop"));
  });

  it("passes non-text events through", async () => {
    const { gov, agentId } = await registerAgent();
    const stream = fakeStream([
      { type: "message_start" },
      { type: "content_block_start", index: 0 },
      textDelta("hello"),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta" },
      { type: "message_stop" },
    ]);
    const governed = createGovernedMessageStream(stream, gov, { agentId });

    const events = await collect(governed({
      model: "claude-sonnet-4-5", max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }));

    // All 6 events should survive.
    assert.equal(events.length, 6);
    assert.equal(events[0].type, "message_start");
    assert.equal(events[5].type, "message_stop");
  });
});

describe("anthropic-stream — sliding mode", () => {
  it("catches cross-chunk pattern with lookback", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const stream = fakeStream([
      textDelta("a "), textDelta("SEC"), textDelta("RET"), textDelta(" end"),
    ]);
    const governed = createGovernedMessageStream(stream, gov, {
      agentId, streamMode: "sliding", streamLookbackChunks: 2,
    });

    await assert.rejects(async () => {
      await collect(governed({
        model: "claude-sonnet-4-5", max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }));
    }, GovernanceBlockedError);
  });
});

describe("anthropic-stream — flags", () => {
  it("postprocess: false leaves output untouched", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const stream = fakeStream([textDelta("SECRET here")]);
    const governed = createGovernedMessageStream(stream, gov, {
      agentId, postprocess: false,
    });
    const events = await collect(governed({
      model: "claude-sonnet-4-5", max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }));
    assert.equal(events[0].delta?.text, "SECRET here");
  });
});
