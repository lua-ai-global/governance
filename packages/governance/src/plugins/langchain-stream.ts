/**
 * governance-sdk LangChain — chat model streaming (postprocess)
 *
 * Companion to `wrapChatModel` in `langchain-model.ts`. LangChain chat models
 * expose `.stream(input)` and `.streamEvents(input)` returning
 * `AsyncGenerator<AIMessageChunk>` (or a richer event graph for streamEvents).
 *
 * We override `.stream()` to:
 *   1. Run preprocess on the last human message once, up-front (same as invoke)
 *   2. Yield each AIMessageChunk through enforcePostprocessStream, scanning
 *      the chunk's `.content` (which may be string or parts array)
 *
 * `streamEvents` is not overridden — the graph format is complex and varies
 * between LangChain versions. Users who need full streamEvents coverage
 * should use `.stream()` + construct their own event wrapper. We document
 * this limitation up front.
 */

import type { GovernanceInstance } from "../index";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePreprocess } from "./pre-post-enforce.js";
import { enforcePostprocessStream } from "./pre-post-stream.js";
import type { StreamMode } from "./pre-post-stream.js";
import type {
  LangChainMessage,
  LangChainChatModel,
  LangChainModelConfig,
} from "./langchain-model.js";

// ─── Types ──────────────────────────────────────────────────────

/**
 * LangChain chat model with streaming support. Extends the base shape used
 * by `wrapChatModel` with the optional `stream` method.
 */
export interface LangChainStreamingChatModel extends LangChainChatModel {
  stream?: (
    input: LangChainMessage[] | string,
    options?: unknown,
  ) => Promise<AsyncIterable<LangChainMessage>> | AsyncIterable<LangChainMessage>;
}

export interface LangChainStreamConfig extends LangChainModelConfig {
  streamMode?: StreamMode;
  streamLookbackChunks?: number;
  streamLookbackChars?: number;
}

// ─── Stream override builder ────────────────────────────────────

/**
 * Build a `.stream` implementation for a wrapped chat model. Used internally
 * by `wrapChatModel` when the underlying model exposes `stream`.
 */
export function buildStreamOverride(
  model: LangChainStreamingChatModel,
  governance: GovernanceInstance,
  config: LangChainStreamConfig,
): LangChainStreamingChatModel["stream"] {
  if (typeof model.stream !== "function") return undefined;
  const callbacks: OutcomeCallbacks = config;
  const runPre = config.preprocess ?? true;
  const runPost = config.postprocess ?? true;

  return async function (
    input: LangChainMessage[] | string,
    options?: unknown,
  ): Promise<AsyncIterable<LangChainMessage>> {
    let workingInput = input;

    if (runPre) {
      const text = extractLastHumanText(input);
      if (text) {
        const pre = await enforcePreprocess(governance, text, {
          agentId: config.agentId,
          agentName: config.agentName,
          agentLevel: config.agentLevel,
          metadata: config.metadata,
          sessionTokensUsed: config.sessionTokenTracker?.(),
          callbacks,
          toolName: "langchain.stream:pre",
        });
        if (pre.text !== text) {
          workingInput = replaceLastHumanText(input, pre.text);
        }
      }
    }

    const rawStream = await model.stream!(workingInput, options);

    if (!runPost) return rawStream;

    return enforcePostprocessStream(governance, rawStream, {
      agentId: config.agentId,
      agentName: config.agentName,
      agentLevel: config.agentLevel,
      metadata: config.metadata,
      sessionTokensUsed: config.sessionTokenTracker?.(),
      callbacks,
      toolName: "langchain.stream",
      streamMode: config.streamMode,
      streamLookbackChunks: config.streamLookbackChunks,
      streamLookbackChars: config.streamLookbackChars,
      extractText: (chunk) => chunkToText(chunk),
      buildMaskedChunk: (orig, masked) => buildMaskedChunk(orig, masked),
    });
  };
}

// ─── Helpers (mirror langchain-model.ts shape) ──────────────────

function extractLastHumanText(input: LangChainMessage[] | string): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  for (let i = input.length - 1; i >= 0; i--) {
    if (!isHuman(input[i])) continue;
    return messageToText(input[i]);
  }
  return "";
}

function isHuman(msg: LangChainMessage): boolean {
  const t = msg._getType?.() ?? msg.type ?? msg.role;
  return t === "human" || t === "user";
}

function messageToText(msg: LangChainMessage): string {
  return chunkToText(msg);
}

function chunkToText(chunk: LangChainMessage): string {
  const content = chunk.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "type" in part) {
          const p = part as { type: string; text?: string };
          if (p.type === "text") return p.text ?? "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function replaceLastHumanText(
  input: LangChainMessage[] | string,
  newText: string,
): LangChainMessage[] | string {
  if (typeof input === "string") return newText;
  if (!Array.isArray(input)) return input;
  const next = input.map((m) => cloneMessage(m));
  for (let i = next.length - 1; i >= 0; i--) {
    if (!isHuman(next[i])) continue;
    setMessageText(next[i], newText);
    break;
  }
  return next;
}

function cloneMessage(msg: LangChainMessage): LangChainMessage {
  const copy = Object.create(Object.getPrototypeOf(msg) as object);
  Object.assign(copy, msg);
  return copy;
}

function setMessageText(msg: LangChainMessage, newText: string): void {
  const content = msg.content;
  if (typeof content === "string") {
    msg.content = newText;
    return;
  }
  if (Array.isArray(content)) {
    const parts = (content as unknown[]).map((p) => {
      if (p && typeof p === "object" && "type" in p && (p as { type: string }).type === "text") {
        return { ...(p as object), text: newText };
      }
      return p;
    });
    const hasText = parts.some(
      (p) => p && typeof p === "object" && "type" in p && (p as { type: string }).type === "text",
    );
    if (!hasText) parts.push({ type: "text", text: newText });
    msg.content = parts;
    return;
  }
  msg.content = newText;
}

function buildMaskedChunk(
  orig: LangChainMessage,
  masked: string,
): LangChainMessage {
  const copy = cloneMessage(orig);
  setMessageText(copy, masked);
  return copy;
}
