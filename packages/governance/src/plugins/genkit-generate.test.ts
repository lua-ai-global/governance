import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
  outputPattern,
} from "../index";
import {
  createGovernedGenerate,
  createGovernedGenerateStream,
} from "./genkit-generate";
import type {
  GenkitGenerateOptions,
  GenkitGenerateResponse,
  GenkitStreamChunk,
  GenkitGenerateStreamResponse,
} from "./genkit-generate";
import { GovernanceBlockedError } from "./outcome-handler";

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "genkit-test", framework: "genkit", owner: "t",
  });
  return { gov, agentId: id };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("genkit-generate — non-streaming", () => {
  it("allow: returns response unchanged", async () => {
    const { gov, agentId } = await registerAgent();
    const generate = async (_o: GenkitGenerateOptions): Promise<GenkitGenerateResponse> => ({
      text: "hi there",
    });
    const wrapped = createGovernedGenerate(generate, gov, { agentId });

    const res = await wrapped({ prompt: "hello" });
    assert.equal(res.text, "hi there");
  });

  it("block: throws on injection in user prompt", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    let called = false;
    const generate = async (): Promise<GenkitGenerateResponse> => {
      called = true;
      return {};
    };
    const wrapped = createGovernedGenerate(generate, gov, { agentId });

    await assert.rejects(
      () => wrapped({ prompt: "please do forbidden stuff" }),
      GovernanceBlockedError,
    );
    assert.equal(called, false);
  });

  it("mask: replaces response text", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const generate = async (): Promise<GenkitGenerateResponse> => ({
      text: "ssn 123-45-6789 leak",
    });
    const wrapped = createGovernedGenerate(generate, gov, { agentId });

    const res = await wrapped({ prompt: "hi" });
    assert.ok(!/123-45-6789/.test(res.text ?? ""), `got: ${res.text}`);
  });

  it("extracts last user message from messages array", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    const generate = async (): Promise<GenkitGenerateResponse> => ({ text: "ok" });
    const wrapped = createGovernedGenerate(generate, gov, { agentId });

    await assert.rejects(
      () => wrapped({
        messages: [
          { role: "system", content: "be helpful" },
          { role: "user", content: "say forbidden word" },
        ],
      }),
      GovernanceBlockedError,
    );
  });
});

describe("genkit-generate — streaming", () => {
  async function* fakeStream(chunks: GenkitStreamChunk[]) {
    for (const c of chunks) yield c;
  }

  function textChunk(text: string): GenkitStreamChunk {
    return { text };
  }

  function streamResp(chunks: GenkitStreamChunk[]): GenkitGenerateStreamResponse {
    return {
      stream: fakeStream(chunks),
      response: Promise.resolve({ text: chunks.map((c) => c.text ?? "").join("") }),
    };
  }

  it("block: cross-chunk pattern throws (buffered default)", async () => {
    const { gov, agentId } = await registerAgent([outputPattern("SECRET", "g")]);
    const wrapped = createGovernedGenerateStream(
      () => streamResp([textChunk("SEC"), textChunk("RET")]),
      gov,
      { agentId },
    );

    const res = await wrapped({ prompt: "hi" });
    await assert.rejects(() => collect(res.stream), GovernanceBlockedError);
  });

  it("mask: redacts chunk text", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const wrapped = createGovernedGenerateStream(
      () => streamResp([textChunk("ssn "), textChunk("123-45-6789 leak")]),
      gov,
      { agentId },
    );

    const res = await wrapped({ prompt: "hi" });
    const chunks = await collect(res.stream);
    const combined = chunks.map((c) => c.text ?? "").join("");
    assert.ok(!/123-45-6789/.test(combined), `got: ${combined}`);
  });

  it("pre-block: throws before generateStream runs", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    let called = false;
    const wrapped = createGovernedGenerateStream(
      () => {
        called = true;
        return streamResp([textChunk("ok")]);
      },
      gov,
      { agentId },
    );

    await assert.rejects(
      () => wrapped({ prompt: "do forbidden thing" }),
      GovernanceBlockedError,
    );
    assert.equal(called, false);
  });
});
