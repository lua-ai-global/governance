/**
 * governance-sdk LangChain — chat model wrapper (pre/post)
 *
 * LangChain's callback system is notification-only — `handleLLMStart` can
 * throw to abort but cannot rewrite prompts, and `handleLLMEnd` cannot mask
 * output. To cover pre + post properly we wrap the chat model itself:
 *
 *   - `wrapChatModel(model, gov, config)` → new Runnable-shaped object whose
 *     `invoke()` runs enforcePreprocess on the last human message, delegates
 *     to the underlying model, then runs enforcePostprocess on the response
 *     (optionally masking it).
 *
 * Structural typing keeps us zero-runtime-deps and LangChain-version-agnostic.
 *
 * @example
 * ```ts
 * import { ChatOpenAI } from '@langchain/openai';
 * import { createGovernance } from 'governance-sdk';
 * import { wrapChatModel } from 'governance-sdk/plugins/langchain';
 *
 * const model = new ChatOpenAI({ model: 'gpt-4o' });
 * const { id: agentId } = await gov.register({
 *   name: 'research', framework: 'langchain', owner: 'team',
 * });
 * const guarded = wrapChatModel(model, gov, { agentId });
 * const res = await guarded.invoke([new HumanMessage('hello')]);
 * ```
 */

import type { GovernanceInstance } from "../index";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePreprocess, enforcePostprocess } from "./pre-post-enforce.js";
import { buildStreamOverride } from "./langchain-stream.js";
import type {
  LangChainStreamingChatModel,
  LangChainStreamConfig,
} from "./langchain-stream.js";
import type { StreamMode } from "./pre-post-stream.js";

// ─── Types ──────────────────────────────────────────────────────

export interface LangChainMessage {
  /**
   * LangChain distinguishes message type via `_getType()` on BaseMessage
   * subclasses (human, ai, system, tool). We accept any callable instance.
   */
  _getType?: () => string;
  /** Some messages also expose a role/type string directly. */
  role?: string;
  type?: string;
  /** Content can be a string or an array of structured parts. */
  content: unknown;
  [key: string]: unknown;
}

export interface LangChainChatModel {
  invoke: (
    input: LangChainMessage[] | string,
    options?: unknown,
  ) => Promise<LangChainMessage>;
  [key: string]: unknown;
}

export interface LangChainModelConfig extends OutcomeCallbacks {
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  preprocess?: boolean;
  postprocess?: boolean;
  metadata?: Record<string, unknown>;
  sessionTokenTracker?: () => number;
  /**
   * Streaming post-scan mode — applies when the underlying model exposes
   * `.stream()`. See pre-post-stream.ts for mode semantics.
   */
  streamMode?: StreamMode;
  streamLookbackChunks?: number;
  streamLookbackChars?: number;
}

// ─── Main Export ────────────────────────────────────────────────

export function wrapChatModel<T extends LangChainChatModel>(
  model: T,
  governance: GovernanceInstance,
  config: LangChainModelConfig,
): T {
  const callbacks: OutcomeCallbacks = config;
  const runPre = config.preprocess ?? true;
  const runPost = config.postprocess ?? true;

  // Preserve prototype so .bindTools(), .pipe(), etc. keep working.
  const wrapped: LangChainChatModel = Object.create(
    Object.getPrototypeOf(model) as object,
  );
  Object.assign(wrapped, model);

  wrapped.invoke = async function (
    input: LangChainMessage[] | string,
    options?: unknown,
  ): Promise<LangChainMessage> {
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
          toolName: "langchain.invoke:pre",
        });
        if (pre.text !== text) {
          workingInput = replaceLastHumanText(input, pre.text);
        }
      }
    }

    const response = await model.invoke(workingInput, options);

    if (!runPost) return response;
    const outText = messageToText(response);
    if (!outText) return response;

    const post = await enforcePostprocess(governance, outText, {
      agentId: config.agentId,
      agentName: config.agentName,
      agentLevel: config.agentLevel,
      metadata: config.metadata,
      sessionTokensUsed: config.sessionTokenTracker?.(),
      callbacks,
      toolName: "langchain.invoke:post",
    });

    if (post.text === outText) return response;
    return replaceMessageText(response, post.text);
  };

  // If the underlying model exposes `.stream()`, install a governed override.
  const streamImpl = buildStreamOverride(
    model as LangChainStreamingChatModel,
    governance,
    config as LangChainStreamConfig,
  );
  if (streamImpl) {
    (wrapped as LangChainStreamingChatModel).stream = streamImpl;
  }

  return wrapped as T;
}

// ─── Re-exports for streaming ───────────────────────────────────

export type {
  LangChainStreamingChatModel,
  LangChainStreamConfig,
} from "./langchain-stream.js";
export type { StreamMode } from "./pre-post-stream.js";

// ─── Helpers ────────────────────────────────────────────────────

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
  const content = msg.content;
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

function replaceMessageText(
  msg: LangChainMessage,
  newText: string,
): LangChainMessage {
  const next = cloneMessage(msg);
  setMessageText(next, newText);
  return next;
}

function cloneMessage(msg: LangChainMessage): LangChainMessage {
  // Preserve prototype so LangChain instanceOf checks keep working.
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
