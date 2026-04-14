/**
 * governance-sdk Vercel AI — LanguageModelMiddleware (pre/post)
 *
 * `createGovernanceMiddleware` returns a middleware object compatible with
 * `experimental_wrapLanguageModel` (Vercel AI SDK 3.4+ / 4.x / 5.x). It
 * intercepts:
 *
 *   - transformParams → pre-scan last user message (injection, blocklists, ...)
 *   - wrapGenerate    → post-scan the resulting model text (masking, PII, ...)
 *
 * Structural typing keeps this SDK-version-agnostic and zero-runtime-deps.
 *
 * @example
 * ```ts
 * import { experimental_wrapLanguageModel, generateText } from 'ai';
 * import { createGovernance } from 'governance-sdk';
 * import { createGovernanceMiddleware } from 'governance-sdk/plugins/vercel-ai';
 *
 * const gov = createGovernance({ rules: [] });
 * const { id: agentId } = await gov.register({
 *   name: 'sales', framework: 'vercel-ai', owner: 'team',
 * });
 *
 * const model = experimental_wrapLanguageModel({
 *   model: openai('gpt-4o'),
 *   middleware: createGovernanceMiddleware(gov, { agentId }),
 * });
 * ```
 */

import type { GovernanceInstance } from "../index";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePreprocess, enforcePostprocess } from "./pre-post-enforce.js";
import { buildWrapStream } from "./vercel-ai-stream.js";
import type {
  VercelStreamPart,
  VercelStreamResult,
} from "./vercel-ai-stream.js";
import type { StreamMode } from "./pre-post-stream.js";

// ─── Types ──────────────────────────────────────────────────────

/** Minimal shape of a Vercel AI LanguageModelMiddleware. */
export interface VercelLanguageModelMiddleware {
  transformParams?: (options: {
    type: "generate" | "stream";
    params: VercelLanguageModelParams;
  }) => Promise<VercelLanguageModelParams>;
  wrapGenerate?: (options: {
    doGenerate: () => Promise<VercelGenerateResult>;
    params: VercelLanguageModelParams;
  }) => Promise<VercelGenerateResult>;
  wrapStream?: (options: {
    doStream: () => Promise<VercelStreamResult>;
    params: VercelLanguageModelParams;
  }) => Promise<VercelStreamResult>;
}

/** Subset of Vercel's LanguageModelV2 params we touch. */
export interface VercelLanguageModelParams {
  prompt?: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
}

/** Subset of Vercel's generate result we touch. */
export interface VercelGenerateResult {
  text?: string;
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  usage?: { inputTokens?: number; outputTokens?: number; [k: string]: unknown };
  [key: string]: unknown;
}

export interface VercelMiddlewareConfig extends OutcomeCallbacks {
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  /** Disable pre-scan of user input (default: enabled). */
  preprocess?: boolean;
  /** Disable post-scan of model output (default: enabled). */
  postprocess?: boolean;
  /** Optional static metadata merged into every EnforcementContext. */
  metadata?: Record<string, unknown>;
  sessionTokenTracker?: () => number;
  /**
   * Streaming post-scan mode (only applies to `streamText` / wrapStream):
   *   - "buffered" (default, safest): scan full output at end, flush all at once
   *   - "sliding": hold back N chunks so patterns spanning chunk boundaries are caught
   *   - "per-chunk": scan each chunk in isolation (fastest, weakest)
   */
  streamMode?: StreamMode;
  /** Sliding mode: chunks to hold back (default 2). */
  streamLookbackChunks?: number;
  /** Sliding mode: chars to hold back (overrides chunk count when exceeded). */
  streamLookbackChars?: number;
}

// ─── Middleware ─────────────────────────────────────────────────

export function createGovernanceMiddleware(
  governance: GovernanceInstance,
  config: VercelMiddlewareConfig,
): VercelLanguageModelMiddleware {
  const callbacks: OutcomeCallbacks = config;
  const runPre = config.preprocess ?? true;
  const runPost = config.postprocess ?? true;

  return {
    transformParams: runPre
      ? async ({ params }) => {
          const text = extractLastUserText(params);
          if (!text) return params;

          const result = await enforcePreprocess(governance, text, {
            agentId: config.agentId,
            agentName: config.agentName,
            agentLevel: config.agentLevel,
            metadata: config.metadata,
            sessionTokensUsed: config.sessionTokenTracker?.(),
            callbacks,
            toolName: "vercel.transformParams",
          });

          if (result.text === text) return params;
          return replaceLastUserText(params, result.text);
        }
      : undefined,

    wrapGenerate: runPost
      ? async ({ doGenerate }) => {
          const result = await doGenerate();
          const text = extractGenerateText(result);
          if (!text) return result;

          const post = await enforcePostprocess(governance, text, {
            agentId: config.agentId,
            agentName: config.agentName,
            agentLevel: config.agentLevel,
            metadata: config.metadata,
            outputTokenCount: result.usage?.outputTokens,
            sessionTokensUsed: config.sessionTokenTracker?.(),
            callbacks,
            toolName: "vercel.wrapGenerate",
          });

          if (post.text === text) return result;
          return replaceGenerateText(result, post.text);
        }
      : undefined,

    // Streaming post-scan — lives in vercel-ai-stream.ts to respect the
    // <300 LOC per file cap.
    wrapStream: runPost ? buildWrapStream(governance, config) : undefined,
  };
}

// Re-export stream types so consumers can import via the main plugin path.
export type { VercelStreamPart, VercelStreamResult } from "./vercel-ai-stream.js";
export type { StreamMode } from "./pre-post-stream.js";

// ─── Prompt helpers ─────────────────────────────────────────────

function extractLastUserText(params: VercelLanguageModelParams): string {
  const prompt = params.prompt;
  if (!Array.isArray(prompt)) return "";
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i];
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
  params: VercelLanguageModelParams,
  newText: string,
): VercelLanguageModelParams {
  const prompt = params.prompt;
  if (!Array.isArray(prompt)) return params;
  const next = prompt.map((m) => ({ ...m }));
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
  return { ...params, prompt: next };
}

function extractGenerateText(result: VercelGenerateResult): string {
  if (typeof result.text === "string" && result.text) return result.text;
  if (Array.isArray(result.content)) {
    return result.content
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
  }
  return "";
}

function replaceGenerateText(
  result: VercelGenerateResult,
  newText: string,
): VercelGenerateResult {
  const next: VercelGenerateResult = { ...result };
  if (typeof result.text === "string") next.text = newText;
  if (Array.isArray(result.content)) {
    const parts = result.content.map((p) =>
      p.type === "text" ? { ...p, text: newText } : p,
    );
    if (!parts.some((p) => p.type === "text")) {
      parts.push({ type: "text", text: newText });
    }
    next.content = parts;
  }
  return next;
}
