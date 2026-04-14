/**
 * governance-sdk Anthropic — messages.stream wrapper (postprocess streaming)
 *
 * Companion to `createGovernedMessages` in `anthropic-messages.ts`. The
 * Anthropic SDK exposes streaming two ways:
 *
 *   - `client.messages.stream(params)` → returns a MessageStream (async iterable
 *     of typed events). Highest level API.
 *   - `client.messages.create({ ..., stream: true })` → returns an async iterable
 *     of RawMessageStreamEvent.
 *
 * Both surface the same underlying event shape for text tokens:
 *
 *   { type: 'content_block_delta',
 *     index: number,
 *     delta: { type: 'text_delta', text: string } }
 *
 * `wrapGovernedMessageStream` wraps either iterable, runs preprocess on the
 * last user message once up-front, then routes `text_delta` events through
 * `enforcePostprocessStream`. Non-text events pass through untouched.
 */

import type { GovernanceInstance } from "../index";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePreprocess } from "./pre-post-enforce.js";
import { enforcePostprocessStream } from "./pre-post-stream.js";
import type { StreamMode } from "./pre-post-stream.js";

// ─── Types ──────────────────────────────────────────────────────

/** Minimal shape of an Anthropic stream event we care about. */
export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface AnthropicStreamParams {
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  model: string;
  max_tokens: number;
  system?: unknown;
  [key: string]: unknown;
}

export interface AnthropicStreamConfig extends OutcomeCallbacks {
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

// ─── wrapGovernedMessageStream ──────────────────────────────────

/**
 * Wrap a stream-producing function (e.g. `client.messages.stream` or a
 * `client.messages.create({stream:true})` caller) with governance.
 *
 * Returns a function with the same signature; the returned stream applies
 * preprocess once, then wraps the event stream through postprocess scanning.
 */
export function createGovernedMessageStream(
  streamFn: (params: AnthropicStreamParams) => AsyncIterable<AnthropicStreamEvent>,
  governance: GovernanceInstance,
  config: AnthropicStreamConfig,
): (params: AnthropicStreamParams) => AsyncIterable<AnthropicStreamEvent> {
  return (params) => wrapGovernedAnthropicStream(streamFn, governance, config, params);
}

async function* wrapGovernedAnthropicStream(
  streamFn: (params: AnthropicStreamParams) => AsyncIterable<AnthropicStreamEvent>,
  governance: GovernanceInstance,
  config: AnthropicStreamConfig,
  params: AnthropicStreamParams,
): AsyncIterable<AnthropicStreamEvent> {
  const callbacks: OutcomeCallbacks = config;
  const runPre = config.preprocess ?? true;
  const runPost = config.postprocess ?? true;

  let workingParams = params;
  if (runPre) {
    const userText = extractLastUserText(params.messages);
    if (userText) {
      const pre = await enforcePreprocess(governance, userText, {
        agentId: config.agentId,
        agentName: config.agentName,
        agentLevel: config.agentLevel,
        metadata: config.metadata,
        sessionTokensUsed: config.sessionTokenTracker?.(),
        callbacks,
        toolName: "anthropic.messages.stream:pre",
      });
      if (pre.text !== userText) {
        workingParams = {
          ...params,
          messages: replaceLastUserText(params.messages, pre.text),
        };
      }
    }
  }

  const source = streamFn(workingParams);

  if (!runPost) {
    yield* source;
    return;
  }

  // Split the event stream into text-delta and passthrough. Collect in order,
  // scan the text-deltas through enforcePostprocessStream, then re-interleave.
  yield* scanAndInterleave(source, governance, config, callbacks);
}

async function* scanAndInterleave(
  source: AsyncIterable<AnthropicStreamEvent>,
  governance: GovernanceInstance,
  config: AnthropicStreamConfig,
  callbacks: OutcomeCallbacks,
): AsyncIterable<AnthropicStreamEvent> {
  const schedule: Array<
    | { kind: "text"; index: number }
    | { kind: "passthrough"; event: AnthropicStreamEvent }
  > = [];
  const textEvents: AnthropicStreamEvent[] = [];

  for await (const event of source) {
    if (isTextDelta(event)) {
      schedule.push({ kind: "text", index: textEvents.length });
      textEvents.push(event);
    } else {
      schedule.push({ kind: "passthrough", event });
    }
  }

  if (textEvents.length === 0) {
    for (const step of schedule) {
      if (step.kind === "passthrough") yield step.event;
    }
    return;
  }

  const scanned: AnthropicStreamEvent[] = [];
  for await (const ev of enforcePostprocessStream(
    governance,
    iterateArray(textEvents),
    {
      agentId: config.agentId,
      agentName: config.agentName,
      agentLevel: config.agentLevel,
      metadata: config.metadata,
      sessionTokensUsed: config.sessionTokenTracker?.(),
      callbacks,
      toolName: "anthropic.messages.stream",
      streamMode: config.streamMode,
      streamLookbackChunks: config.streamLookbackChunks,
      streamLookbackChars: config.streamLookbackChars,
      extractText: (e) => e.delta?.text ?? "",
      buildMaskedChunk: (orig, maskedText) => ({
        ...orig,
        delta: { ...(orig.delta ?? {}), type: "text_delta", text: maskedText },
      }),
    },
  )) {
    scanned.push(ev);
  }

  let scannedCursor = 0;
  for (const step of schedule) {
    if (step.kind === "passthrough") {
      yield step.event;
      continue;
    }
    if (scannedCursor < scanned.length) {
      yield scanned[scannedCursor++];
    }
  }
  while (scannedCursor < scanned.length) {
    yield scanned[scannedCursor++];
  }
}

function isTextDelta(ev: AnthropicStreamEvent): boolean {
  return (
    ev.type === "content_block_delta" &&
    ev.delta?.type === "text_delta" &&
    typeof ev.delta?.text === "string"
  );
}

async function* iterateArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

function extractLastUserText(
  messages: AnthropicStreamParams["messages"],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    return contentToText(msg.content);
  }
  return "";
}

function contentToText(content: unknown): string {
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

function replaceLastUserText(
  messages: AnthropicStreamParams["messages"],
  newText: string,
): AnthropicStreamParams["messages"] {
  const next = messages.map((m) => ({ ...m }));
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role !== "user") continue;
    const msg = next[i];
    if (typeof msg.content === "string") {
      msg.content = newText;
    } else if (Array.isArray(msg.content)) {
      const parts = (msg.content as unknown[]).map((p) => {
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
    }
    break;
  }
  return next;
}
