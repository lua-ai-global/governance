/**
 * governance-sdk Ollama — chat wrapper (pre/post + streaming)
 *
 * Wraps Ollama's JS SDK `chat` call with governance pre/post enforcement.
 * Ollama's `chat` has dual shapes depending on the `stream` option:
 *
 *   - non-streaming (stream: false or omitted): Promise<ChatResponse>
 *   - streaming (stream: true): AsyncIterable<ChatResponseChunk>
 *
 * We expose two functions rather than trying to overload one:
 *
 *   - `createGovernedOllamaChat(client.chat, gov, config)` for non-streaming
 *   - `createGovernedOllamaChatStream(client.chat.bind(client), gov, config)`
 *     for streaming (call the underlying with stream: true yourself)
 *
 * @example
 * ```ts
 * import { Ollama } from 'ollama';
 * import { createGovernance } from 'governance-sdk';
 * import { createGovernedOllamaChat } from 'governance-sdk/plugins/ollama';
 *
 * const client = new Ollama();
 * const { id: agentId } = await gov.register({
 *   name: 'local', framework: 'ollama', owner: 'me',
 * });
 * const chat = createGovernedOllamaChat(client.chat.bind(client), gov, { agentId });
 * const res = await chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
 * ```
 */

import type { GovernanceInstance } from "../index";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePreprocess, enforcePostprocess } from "./pre-post-enforce.js";
import { enforcePostprocessStream } from "./pre-post-stream.js";
import type { StreamMode } from "./pre-post-stream.js";

// ─── Types ──────────────────────────────────────────────────────

export interface OllamaChatParams {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  [key: string]: unknown;
}

export interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  [key: string]: unknown;
}

export interface OllamaChatChunk {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  [key: string]: unknown;
}

export interface OllamaChatConfig extends OutcomeCallbacks {
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  preprocess?: boolean;
  postprocess?: boolean;
  metadata?: Record<string, unknown>;
  sessionTokenTracker?: () => number;
  streamMode?: StreamMode;
  streamLookbackChunks?: number;
  streamLookbackChars?: number;
}

// ─── Non-streaming wrapper ─────────────────────────────────────

export function createGovernedOllamaChat(
  chat: (params: OllamaChatParams) => Promise<OllamaChatResponse>,
  governance: GovernanceInstance,
  config: OllamaChatConfig,
): (params: OllamaChatParams) => Promise<OllamaChatResponse> {
  const callbacks: OutcomeCallbacks = config;
  const runPre = config.preprocess ?? true;
  const runPost = config.postprocess ?? true;

  return async (params) => {
    let workingParams = params;

    if (runPre) {
      const text = extractLastUserText(params.messages);
      if (text) {
        const pre = await enforcePreprocess(governance, text, {
          agentId: config.agentId,
          agentName: config.agentName,
          agentLevel: config.agentLevel,
          metadata: config.metadata,
          sessionTokensUsed: config.sessionTokenTracker?.(),
          callbacks,
          toolName: "ollama.chat:pre",
        });
        if (pre.text !== text) {
          workingParams = {
            ...params,
            messages: replaceLastUserText(params.messages, pre.text),
          };
        }
      }
    }

    const response = await chat(workingParams);

    if (!runPost) return response;
    const outText = response.message?.content ?? "";
    if (!outText) return response;

    const post = await enforcePostprocess(governance, outText, {
      agentId: config.agentId,
      agentName: config.agentName,
      agentLevel: config.agentLevel,
      metadata: config.metadata,
      outputTokenCount: response.eval_count,
      sessionTokensUsed: config.sessionTokenTracker?.(),
      callbacks,
      toolName: "ollama.chat:post",
    });

    if (post.text === outText) return response;
    return {
      ...response,
      message: { ...(response.message ?? {}), content: post.text },
    };
  };
}

// ─── Streaming wrapper ─────────────────────────────────────────

export function createGovernedOllamaChatStream(
  streamChat: (params: OllamaChatParams) => AsyncIterable<OllamaChatChunk>,
  governance: GovernanceInstance,
  config: OllamaChatConfig,
): (params: OllamaChatParams) => AsyncIterable<OllamaChatChunk> {
  return (params) => wrapGovernedOllamaStream(streamChat, governance, config, params);
}

async function* wrapGovernedOllamaStream(
  streamChat: (params: OllamaChatParams) => AsyncIterable<OllamaChatChunk>,
  governance: GovernanceInstance,
  config: OllamaChatConfig,
  params: OllamaChatParams,
): AsyncIterable<OllamaChatChunk> {
  const callbacks: OutcomeCallbacks = config;
  const runPre = config.preprocess ?? true;
  const runPost = config.postprocess ?? true;

  let workingParams = params;
  if (runPre) {
    const text = extractLastUserText(params.messages);
    if (text) {
      const pre = await enforcePreprocess(governance, text, {
        agentId: config.agentId,
        agentName: config.agentName,
        agentLevel: config.agentLevel,
        metadata: config.metadata,
        sessionTokensUsed: config.sessionTokenTracker?.(),
        callbacks,
        toolName: "ollama.chat.stream:pre",
      });
      if (pre.text !== text) {
        workingParams = {
          ...params,
          messages: replaceLastUserText(params.messages, pre.text),
        };
      }
    }
  }

  const source = streamChat(workingParams);
  if (!runPost) {
    yield* source;
    return;
  }

  yield* enforcePostprocessStream(governance, source, {
    agentId: config.agentId,
    agentName: config.agentName,
    agentLevel: config.agentLevel,
    metadata: config.metadata,
    sessionTokensUsed: config.sessionTokenTracker?.(),
    callbacks,
    toolName: "ollama.chat.stream",
    streamMode: config.streamMode,
    streamLookbackChunks: config.streamLookbackChunks,
    streamLookbackChars: config.streamLookbackChars,
    extractText: (c) => c.message?.content ?? "",
    buildMaskedChunk: (orig, masked) => ({
      ...orig,
      message: { ...(orig.message ?? {}), content: masked },
    }),
  });
}

// ─── Helpers ────────────────────────────────────────────────────

function extractLastUserText(messages: OllamaChatParams["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const content = messages[i].content;
    if (typeof content === "string") return content;
    return "";
  }
  return "";
}

function replaceLastUserText(
  messages: OllamaChatParams["messages"],
  newText: string,
): OllamaChatParams["messages"] {
  const next = messages.map((m) => ({ ...m }));
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role !== "user") continue;
    next[i].content = newText;
    break;
  }
  return next;
}
