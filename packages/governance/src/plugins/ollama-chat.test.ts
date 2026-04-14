import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
  outputPattern,
} from "../index";
import {
  createGovernedOllamaChat,
  createGovernedOllamaChatStream,
} from "./ollama-chat";
import type {
  OllamaChatParams,
  OllamaChatResponse,
  OllamaChatChunk,
} from "./ollama-chat";
import { GovernanceBlockedError } from "./outcome-handler";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "ollama-test", framework: "ollama", owner: "t",
  });
  return { gov, agentId: id };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("ollama-chat — non-streaming", () => {
  it("allow: returns response unchanged", async () => {
    const { gov, agentId } = await registerAgent();
    const underlying = async (_p: OllamaChatParams): Promise<OllamaChatResponse> => ({
      message: { role: "assistant", content: "hello" },
    });
    const wrapped = createGovernedOllamaChat(underlying, gov, { agentId });

    const res = await wrapped({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.message?.content, "hello");
  });

  it("block: throws before underlying chat runs", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    let called = false;
    const underlying = async (): Promise<OllamaChatResponse> => {
      called = true;
      return {};
    };
    const wrapped = createGovernedOllamaChat(underlying, gov, { agentId });

    await assert.rejects(
      () => wrapped({
        model: "llama3",
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
    const underlying = async (): Promise<OllamaChatResponse> => ({
      message: { role: "assistant", content: "ssn 123-45-6789 leak" },
    });
    const wrapped = createGovernedOllamaChat(underlying, gov, { agentId });

    const res = await wrapped({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.ok(
      !/123-45-6789/.test(res.message?.content ?? ""),
      `expected masked, got: ${res.message?.content}`,
    );
  });
});

describe("ollama-chat — streaming", () => {
  async function* fakeStream(chunks: OllamaChatChunk[]) {
    for (const c of chunks) yield c;
  }

  function textChunk(content: string, done = false): OllamaChatChunk {
    return { message: { role: "assistant", content }, done };
  }

  it("block: cross-chunk pattern throws (buffered default)", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const wrapped = createGovernedOllamaChatStream(
      () => fakeStream([textChunk("SEC"), textChunk("RET", true)]),
      gov,
      { agentId },
    );

    await assert.rejects(
      () => collect(wrapped({
        model: "llama3",
        messages: [{ role: "user", content: "hi" }],
      })),
      GovernanceBlockedError,
    );
  });

  it("mask: redacts delta content", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const wrapped = createGovernedOllamaChatStream(
      () => fakeStream([textChunk("ssn "), textChunk("123-45-6789 leak", true)]),
      gov,
      { agentId },
    );

    const chunks = await collect(wrapped({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    }));
    const combined = chunks.map((c) => c.message?.content ?? "").join("");
    assert.ok(!/123-45-6789/.test(combined), `expected masked, got: ${combined}`);
  });

  it("pre-block: throws before underlying stream runs", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    let called = false;
    const wrapped = createGovernedOllamaChatStream(
      () => {
        called = true;
        return fakeStream([textChunk("x", true)]);
      },
      gov,
      { agentId },
    );

    await assert.rejects(
      () => collect(wrapped({
        model: "llama3",
        messages: [{ role: "user", content: "do forbidden thing" }],
      })),
      GovernanceBlockedError,
    );
    assert.equal(called, false);
  });
});
