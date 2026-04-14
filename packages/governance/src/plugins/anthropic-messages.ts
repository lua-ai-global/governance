/**
 * governance-sdk Anthropic — messages.create wrapper (pre/post)
 *
 * The Anthropic SDK has no native middleware hook, so we wrap
 * `client.messages.create`:
 *
 *   - pre  → scan the last user message block before sending
 *   - post → scan the assistant response content[] after receiving
 *
 * Returns a drop-in replacement for `client.messages.create`. Users keep
 * their existing call site; governance is applied transparently.
 *
 * @example
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { createGovernance } from 'governance-sdk';
 * import { createGovernedMessages } from 'governance-sdk/plugins/anthropic';
 *
 * const client = new Anthropic();
 * const gov = createGovernance({ rules: [] });
 * const { id: agentId } = await gov.register({
 *   name: 'assistant', framework: 'anthropic', owner: 'team',
 * });
 *
 * const messages = createGovernedMessages(client.messages, gov, { agentId });
 * const res = await messages.create({
 *   model: 'claude-sonnet-4-5', max_tokens: 1024,
 *   messages: [{ role: 'user', content: 'hi' }],
 * });
 * ```
 */

import type { GovernanceInstance } from "../index";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePreprocess, enforcePostprocess } from "./pre-post-enforce.js";

// ─── Types ──────────────────────────────────────────────────────

/** Minimal shape of an Anthropic messages client (SDK-version-agnostic). */
export interface AnthropicMessagesClient {
  create: (params: AnthropicMessagesCreateParams) => Promise<AnthropicMessage>;
}

export interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  system?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number; [k: string]: unknown };
  [key: string]: unknown;
}

export interface AnthropicMessagesConfig extends OutcomeCallbacks {
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  /** Disable pre-scan (default: enabled). */
  preprocess?: boolean;
  /** Disable post-scan (default: enabled). */
  postprocess?: boolean;
  metadata?: Record<string, unknown>;
  sessionTokenTracker?: () => number;
}

// ─── Main Export ────────────────────────────────────────────────

export function createGovernedMessages(
  messages: AnthropicMessagesClient,
  governance: GovernanceInstance,
  config: AnthropicMessagesConfig,
): AnthropicMessagesClient {
  const callbacks: OutcomeCallbacks = config;
  const runPre = config.preprocess ?? true;
  const runPost = config.postprocess ?? true;

  return {
    create: async (params) => {
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
            toolName: "anthropic.messages.create:pre",
          });
          if (pre.text !== text) {
            workingParams = {
              ...params,
              messages: replaceLastUserText(params.messages, pre.text),
            };
          }
        }
      }

      const response = await messages.create(workingParams);

      if (!runPost) return response;
      const outText = extractAssistantText(response);
      if (!outText) return response;

      const post = await enforcePostprocess(governance, outText, {
        agentId: config.agentId,
        agentName: config.agentName,
        agentLevel: config.agentLevel,
        metadata: config.metadata,
        outputTokenCount: response.usage?.output_tokens,
        sessionTokensUsed: config.sessionTokenTracker?.(),
        callbacks,
        toolName: "anthropic.messages.create:post",
      });

      if (post.text === outText) return response;
      return replaceAssistantText(response, post.text);
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function extractLastUserText(
  messages: AnthropicMessagesCreateParams["messages"],
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
  messages: AnthropicMessagesCreateParams["messages"],
  newText: string,
): AnthropicMessagesCreateParams["messages"] {
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

function extractAssistantText(message: AnthropicMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function replaceAssistantText(
  message: AnthropicMessage,
  newText: string,
): AnthropicMessage {
  if (!Array.isArray(message.content)) return message;
  const content = message.content.map((p) =>
    p.type === "text" ? { ...p, text: newText } : p,
  );
  if (!content.some((p) => p.type === "text")) {
    content.push({ type: "text", text: newText });
  }
  return { ...message, content };
}
