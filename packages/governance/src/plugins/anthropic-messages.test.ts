import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernance,
  inputBlocklist,
  maskOutputPattern,
} from "../index";
import { createGovernedMessages } from "./anthropic-messages";
import type {
  AnthropicMessage,
  AnthropicMessagesCreateParams,
} from "./anthropic-messages";
import { GovernanceBlockedError } from "./outcome-handler";

function stubClient(reply: AnthropicMessage) {
  let received: AnthropicMessagesCreateParams | null = null;
  return {
    client: {
      create: async (p: AnthropicMessagesCreateParams) => {
        received = p;
        return reply;
      },
    },
    getReceived: () => received,
  };
}

async function registerAgent(rules: Parameters<typeof createGovernance>[0]["rules"] = []) {
  const gov = createGovernance({ rules });
  const { id } = await gov.register({
    name: "anthropic-test", framework: "anthropic", owner: "t",
  });
  return { gov, agentId: id };
}

describe("anthropic-messages — preprocess", () => {
  it("allow: forwards params to underlying client unchanged", async () => {
    const { gov, agentId } = await registerAgent();
    const { client, getReceived } = stubClient({
      content: [{ type: "text", text: "hi!" }],
    });
    const messages = createGovernedMessages(client, gov, { agentId });

    await messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    });

    const received = getReceived();
    assert.ok(received);
    assert.equal(received!.messages[0].content, "hello");
  });

  it("block: throws BEFORE the underlying client is called", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    let called = false;
    const client = {
      create: async () => { called = true; return {} as AnthropicMessage; },
    };
    const messages = createGovernedMessages(client, gov, { agentId });

    await assert.rejects(
      () =>
        messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "do forbidden thing" }],
        }),
      GovernanceBlockedError,
    );
    assert.equal(called, false);
  });

  it("handles parts-array user content", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["bad"])]);
    const client = {
      create: async () => ({} as AnthropicMessage),
    };
    const messages = createGovernedMessages(client, gov, { agentId });

    await assert.rejects(
      () =>
        messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [
            { role: "user", content: [{ type: "text", text: "this is bad" }] },
          ],
        }),
      GovernanceBlockedError,
    );
  });
});

describe("anthropic-messages — postprocess", () => {
  it("mask: replaces assistant text with masked version", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const { client } = stubClient({
      content: [{ type: "text", text: "ssn 123-45-6789 is sensitive" }],
    });
    const messages = createGovernedMessages(client, gov, { agentId });

    const res = await messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "tell me" }],
    });

    const text = res.content?.[0].text;
    assert.ok(text);
    assert.notEqual(text, "ssn 123-45-6789 is sensitive");
  });

  it("allow: returns response unchanged", async () => {
    const { gov, agentId } = await registerAgent();
    const { client } = stubClient({
      content: [{ type: "text", text: "safe response" }],
    });
    const messages = createGovernedMessages(client, gov, { agentId });

    const res = await messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.content?.[0].text, "safe response");
  });
});

describe("anthropic-messages — flags", () => {
  it("preprocess: false skips input scan", async () => {
    const { gov, agentId } = await registerAgent([inputBlocklist(["forbidden"])]);
    const { client } = stubClient({ content: [{ type: "text", text: "ok" }] });
    const messages = createGovernedMessages(client, gov, {
      agentId,
      preprocess: false,
    });

    // Should NOT throw despite blocklist — preprocess is disabled.
    const res = await messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "do forbidden thing" }],
    });
    assert.equal(res.content?.[0].text, "ok");
  });

  it("postprocess: false skips output scan", async () => {
    const { gov, agentId } = await registerAgent([
      maskOutputPattern("\\d{3}-\\d{2}-\\d{4}", "g"),
    ]);
    const { client } = stubClient({
      content: [{ type: "text", text: "ssn 123-45-6789 leak" }],
    });
    const messages = createGovernedMessages(client, gov, {
      agentId,
      postprocess: false,
    });

    const res = await messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "q" }],
    });
    // Should pass through unmasked.
    assert.equal(res.content?.[0].text, "ssn 123-45-6789 leak");
  });
});
