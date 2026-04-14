import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
  outputPattern,
} from "../index";
import {
  createGovernedChat,
  createGovernedChatStream,
} from "./mistral-messages";
import type {
  MistralChatParams,
  MistralChatResponse,
  MistralStreamEvent,
} from "./mistral-messages";
import { GovernanceBlockedError } from "./outcome-handler";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "mistral-test", framework: "mistral", owner: "t",
  });
  return { gov, agentId: id };
}

function stubChat(reply: string) {
  let received: MistralChatParams | null = null;
  return {
    chat: {
      complete: async (p: MistralChatParams): Promise<MistralChatResponse> => {
        received = p;
        return { choices: [{ message: { content: reply } }] };
      },
    },
    getReceived: () => received,
  };
}

describe("mistral-messages — non-streaming", () => {
  it("allow: forwards params and returns response unchanged", async () => {
    const { gov, agentId } = await registerAgent();
    const { chat, getReceived } = stubChat("hi!");
    const wrapped = createGovernedChat(chat, gov, { agentId });

    const res = await wrapped.complete({
      model: "mistral-large",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(res.choices?.[0].message?.content, "hi!");
    assert.equal(getReceived()!.messages[0].content, "hello");
  });

  it("block: throws before underlying complete runs", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    let called = false;
    const chat = {
      complete: async () => {
        called = true;
        return { choices: [] } as MistralChatResponse;
      },
    };
    const wrapped = createGovernedChat(chat, gov, { agentId });

    await assert.rejects(
      () => wrapped.complete({
        model: "mistral-large",
        messages: [{ role: "user", content: "do forbidden thing" }],
      }),
      GovernanceBlockedError,
    );
    assert.equal(called, false);
  });

  it("mask: replaces assistant content with masked text", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const { chat } = stubChat("ssn 123-45-6789 leak");
    const wrapped = createGovernedChat(chat, gov, { agentId });

    const res = await wrapped.complete({
      model: "mistral-large",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = res.choices?.[0].message?.content as string;
    assert.ok(!/123-45-6789/.test(out), `expected masked, got: ${out}`);
  });
});

describe("mistral-messages — streaming", () => {
  async function* fakeStream(events: MistralStreamEvent[]) {
    for (const e of events) yield e;
  }

  function textEvent(content: string): MistralStreamEvent {
    return { data: { choices: [{ delta: { content } }] } };
  }

  async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of iter) out.push(x);
    return out;
  }

  it("block: cross-chunk pattern throws (buffered default)", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const wrapped = createGovernedChatStream(
      () => fakeStream([textEvent("SEC"), textEvent("RET")]),
      gov,
      { agentId },
    );

    await assert.rejects(
      () => collect(wrapped({
        model: "mistral-large",
        messages: [{ role: "user", content: "hi" }],
      })),
      GovernanceBlockedError,
    );
  });

  it("mask: replaces delta content with masked text", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const wrapped = createGovernedChatStream(
      () => fakeStream([textEvent("ssn "), textEvent("123-45-6789 leak")]),
      gov,
      { agentId },
    );

    const events = await collect(wrapped({
      model: "mistral-large",
      messages: [{ role: "user", content: "hi" }],
    }));
    const combined = events
      .map((e) => e.data?.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.ok(!/123-45-6789/.test(combined), `expected masked, got: ${combined}`);
  });

  it("pre-block: throws before streamFn runs", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    let called = false;
    const wrapped = createGovernedChatStream(
      () => {
        called = true;
        return fakeStream([textEvent("x")]);
      },
      gov,
      { agentId },
    );

    await assert.rejects(
      () => collect(wrapped({
        model: "mistral-large",
        messages: [{ role: "user", content: "do forbidden thing" }],
      })),
      GovernanceBlockedError,
    );
    assert.equal(called, false);
  });
});
