import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
  outputPattern,
} from "../index";
import { wrapLlamaLLM } from "./llamaindex-llm";
import type {
  LlamaChatRequest,
  LlamaChatResponse,
  LlamaChatResponseChunk,
  LlamaLLM,
} from "./llamaindex-llm";
import { GovernanceBlockedError } from "./outcome-handler";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "llama-test", framework: "llamaindex", owner: "t",
  });
  return { gov, agentId: id };
}

function fakeLLM(reply: string): LlamaLLM & { received?: LlamaChatRequest } {
  const llm: LlamaLLM & { received?: LlamaChatRequest } = {
    chat(request: LlamaChatRequest) {
      llm.received = request;
      if (request.stream) {
        return (async function* () {
          // emit the reply as two chunks so we can test cross-chunk
          const half = Math.ceil(reply.length / 2);
          yield { delta: reply.slice(0, half) } as LlamaChatResponseChunk;
          yield { delta: reply.slice(half) } as LlamaChatResponseChunk;
        })();
      }
      const response: LlamaChatResponse = {
        message: { role: "assistant", content: reply },
      };
      return Promise.resolve(response);
    },
  };
  return llm;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("llamaindex-llm — non-streaming", () => {
  it("allow: returns response unchanged", async () => {
    const { gov, agentId } = await registerAgent();
    const llm = fakeLLM("hi!");
    const wrapped = wrapLlamaLLM(llm, gov, { agentId });

    const res = (await wrapped.chat({
      messages: [{ role: "user", content: "hello" }],
    })) as LlamaChatResponse;
    assert.equal(res.message?.content, "hi!");
  });

  it("block: throws on injection in user message", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    const llm = fakeLLM("should not see me");
    const wrapped = wrapLlamaLLM(llm, gov, { agentId });

    await assert.rejects(
      () => wrapped.chat({
        messages: [{ role: "user", content: "do forbidden thing" }],
      }) as Promise<LlamaChatResponse>,
      GovernanceBlockedError,
    );
    assert.equal(llm.received, undefined);
  });

  it("mask: replaces assistant content", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const llm = fakeLLM("ssn 123-45-6789 leak");
    const wrapped = wrapLlamaLLM(llm, gov, { agentId });

    const res = (await wrapped.chat({
      messages: [{ role: "user", content: "hi" }],
    })) as LlamaChatResponse;
    const content = res.message?.content as string;
    assert.ok(!/123-45-6789/.test(content), `got: ${content}`);
  });
});

describe("llamaindex-llm — streaming", () => {
  it("block: cross-chunk pattern throws", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const llm = fakeLLM("SECRET"); // split into "SEC" + "RET"
    const wrapped = wrapLlamaLLM(llm, gov, { agentId });

    const iter = wrapped.chat({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }) as AsyncIterable<LlamaChatResponseChunk>;

    await assert.rejects(() => collect(iter), GovernanceBlockedError);
  });

  it("mask: redacts delta content", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const llm = fakeLLM("123-45-6789 leak");
    const wrapped = wrapLlamaLLM(llm, gov, { agentId });

    const iter = wrapped.chat({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }) as AsyncIterable<LlamaChatResponseChunk>;

    const chunks = await collect(iter);
    const combined = chunks.map((c) => c.delta ?? "").join("");
    assert.ok(!/123-45-6789/.test(combined), `got: ${combined}`);
  });

  it("pre-block: throws before stream starts", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    const llm = fakeLLM("ok");
    const wrapped = wrapLlamaLLM(llm, gov, { agentId });

    const iter = wrapped.chat({
      messages: [{ role: "user", content: "do forbidden thing" }],
      stream: true,
    }) as AsyncIterable<LlamaChatResponseChunk>;

    await assert.rejects(() => collect(iter), GovernanceBlockedError);
  });
});
