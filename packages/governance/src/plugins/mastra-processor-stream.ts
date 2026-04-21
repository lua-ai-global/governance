/**
 * governance-sdk Mastra Processor — per-chunk streaming (processOutputStream)
 *
 * Mastra calls `processOutputStream` once per chunk emitted by agent.stream().
 * The hook can:
 *   - return the chunk (possibly mutated) → emit to the user
 *   - return null/undefined → drop the chunk
 *   - call args.abort(reason) → tripwire the whole stream
 *
 * This is a fundamentally *per-chunk* API — we can't accumulate and flush
 * out-of-band like we do in `enforcePostprocessStream` for other adapters.
 * To support the three modes we keep on `args.state`:
 *
 *   - "per-chunk" (default): scan the chunk's text in isolation, mask or
 *     block per chunk. Fast, weakest (misses cross-chunk patterns).
 *
 *   - "sliding": maintain a rolling text buffer on state; scan the buffer
 *     on every chunk (so cross-chunk patterns are caught) but only emit
 *     the current chunk. On mask, emit the chunk with masked suffix; on
 *     block, abort.
 *
 *   - "buffered": never emit per-chunk content (return null for text parts),
 *     rely entirely on the existing `processOutputResult` hook to scan the
 *     full assembled output. Non-text parts pass through.
 */

import type { GovernanceInstance } from "../index";
import type { EnforcementDecision } from "../policy";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import {
  GovernanceBlockedError,
  GovernanceApprovalRequiredError,
} from "./outcome-handler.js";
import { enforcePostprocess } from "./pre-post-enforce.js";
import type {
  GovernanceProcessorConfig,
  MastraStreamChunk,
  ProcessOutputStreamArgs,
} from "./mastra-processor-types.js";

// ─── State shape kept on args.state ───────────────────────────

interface StreamState {
  /** Rolling window of text seen so far (sliding mode). */
  slidingBuffer?: string;
  /** Chunk count in the rolling window (sliding mode). */
  slidingChunks?: number;
  /**
   * Stable id for this stream. Every per-chunk enforce call carries it
   * in metadata so the cloud dashboard can collapse N audit rows into
   * one logical operation. Lazily generated — first chunk seen.
   */
  streamId?: string;
  /** Monotonically increasing slice number for per-chunk audit tags. */
  streamSlice?: number;
}

/** Zero-dep UUID generator, same helper shape as supply-chain-cyclonedx. */
function generateStreamId(): string {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.randomUUID) {
    return `str_${globalThis.crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `str_${hex}`;
}

/**
 * Read (and lazily init) the streamId + slice index for this Mastra
 * stream. Stored on args.state so subsequent chunks share the same id
 * across the whole stream lifecycle. Caller mutates state.streamSlice++
 * after consuming.
 */
function getOrCreateStreamMeta(
  state: StreamState,
): { streamId: string; slice: number } {
  if (!state.streamId) state.streamId = generateStreamId();
  if (state.streamSlice == null) state.streamSlice = 0;
  const slice = state.streamSlice;
  state.streamSlice = slice + 1;
  return { streamId: state.streamId, slice };
}

// ─── Entry point ──────────────────────────────────────────────

/**
 * Called from GovernanceProcessor.processOutputStream. Returns the (possibly
 * mutated) chunk to emit, or `null`/`undefined` to drop it. May call
 * args.abort() to tripwire the stream.
 */
export async function governStreamChunk(
  args: ProcessOutputStreamArgs,
  governance: GovernanceInstance,
  config: GovernanceProcessorConfig,
  agentId: string,
  agentLevel: number,
  callbacks: OutcomeCallbacks,
): Promise<MastraStreamChunk | null | undefined> {
  if (config.skipStreamPostprocess) return args.part;

  const mode = config.streamMode ?? "per-chunk";
  if (mode === "buffered") return handleBuffered(args);

  const chunkText = extractChunkText(args.part);
  if (!chunkText) return args.part;

  if (mode === "per-chunk") {
    return handlePerChunk(
      args, chunkText, governance, config, agentId, agentLevel, callbacks,
    );
  }
  return handleSliding(
    args, chunkText, governance, config, agentId, agentLevel, callbacks,
  );
}

// ─── Modes ────────────────────────────────────────────────────

/** Buffered: suppress text chunks, let processOutputResult handle scanning. */
function handleBuffered(
  args: ProcessOutputStreamArgs,
): MastraStreamChunk | null {
  if (isTextPart(args.part)) return null;
  return args.part;
}

/** Per-chunk: scan each chunk's text independently, mask if matched. */
async function handlePerChunk(
  args: ProcessOutputStreamArgs,
  chunkText: string,
  governance: GovernanceInstance,
  config: GovernanceProcessorConfig,
  agentId: string,
  agentLevel: number,
  callbacks: OutcomeCallbacks,
): Promise<MastraStreamChunk | null | undefined> {
  const state = (args.state ?? {}) as StreamState;
  const streamMeta = getOrCreateStreamMeta(state);
  if (args.state && args.state !== state) Object.assign(args.state, state);

  const decision = await runScan(
    governance, chunkText, config, agentId, agentLevel, callbacks,
    "mastra.stream:per-chunk", streamMeta,
  );
  return applyDecisionToChunk(args, decision, chunkText, config);
}

/**
 * Sliding: accumulate chunk text on state.slidingBuffer; scan the full
 * buffer so cross-chunk patterns are caught; emit only the current chunk.
 * On mask, the decision applies to the whole buffer — we can't retroactively
 * redact already-emitted chunks, so we emit the current chunk masked (its
 * portion of the masked suffix) and record that a mask fired.
 */
async function handleSliding(
  args: ProcessOutputStreamArgs,
  chunkText: string,
  governance: GovernanceInstance,
  config: GovernanceProcessorConfig,
  agentId: string,
  agentLevel: number,
  callbacks: OutcomeCallbacks,
): Promise<MastraStreamChunk | null | undefined> {
  const state = (args.state ?? {}) as StreamState;
  const streamMeta = getOrCreateStreamMeta(state);
  const lookback = config.streamLookbackChunks ?? 2;
  const lookbackChars = config.streamLookbackChars;

  const nextBuffer = (state.slidingBuffer ?? "") + chunkText;
  const nextChunks = (state.slidingChunks ?? 0) + 1;

  const decision = await runScan(
    governance, nextBuffer, config, agentId, agentLevel, callbacks,
    "mastra.stream:sliding", streamMeta,
  );

  // Trim the buffer once it grows past the lookback budget so it doesn't
  // grow unbounded across long streams.
  let trimmedBuffer = nextBuffer;
  let trimmedChunks = nextChunks;
  if (nextChunks > lookback) {
    const keepStart = Math.max(0, nextBuffer.length - (lookbackChars ?? nextBuffer.length));
    trimmedBuffer = nextBuffer.slice(keepStart);
    trimmedChunks = lookback;
  }
  if (lookbackChars != null && trimmedBuffer.length > lookbackChars) {
    trimmedBuffer = trimmedBuffer.slice(trimmedBuffer.length - lookbackChars);
  }

  state.slidingBuffer = trimmedBuffer;
  state.slidingChunks = trimmedChunks;
  if (args.state && args.state !== state) {
    Object.assign(args.state, state);
  } else if (!args.state) {
    // state wasn't writable — reader won't persist, but we still made the
    // scan above with the correct window. Per-call fallback.
  }

  return applyDecisionToChunk(args, decision, chunkText, config);
}

// ─── Helpers ──────────────────────────────────────────────────

async function runScan(
  governance: GovernanceInstance,
  text: string,
  config: GovernanceProcessorConfig,
  agentId: string,
  agentLevel: number,
  callbacks: OutcomeCallbacks,
  toolName: string,
  streamMeta?: { streamId: string; slice: number },
): Promise<EnforcementDecision> {
  // enforcePostprocess throws on block / require_approval (via handleOutcome).
  // In Mastra's per-chunk API we can't throw — we must call args.abort().
  // So we catch the governance errors here and surface the decision to the
  // caller, which will then call args.abort() with the right payload.
  try {
    const result = await enforcePostprocess(governance, text, {
      agentId,
      agentName: config.agentName,
      agentLevel,
      metadata: {
        ...(config.metadata ?? {}),
        ...(streamMeta
          ? { streamId: streamMeta.streamId, streamSlice: streamMeta.slice }
          : {}),
      },
      callbacks,
      toolName,
    });
    return result.decision;
  } catch (err) {
    if (
      err instanceof GovernanceBlockedError ||
      err instanceof GovernanceApprovalRequiredError
    ) {
      return err.decision;
    }
    throw err;
  }
}

function applyDecisionToChunk(
  args: ProcessOutputStreamArgs,
  decision: EnforcementDecision,
  originalChunkText: string,
  config: GovernanceProcessorConfig,
): MastraStreamChunk | null | undefined {
  if (decision.outcome === "block") {
    config.onStreamBlocked?.(decision, originalChunkText);
    args.abort(
      `[GOVERNANCE] Stream blocked — ${decision.reason ?? "policy violation"} (rule: ${decision.ruleId ?? "unknown"})`,
      { retry: false, metadata: { decision } },
    );
    return null;
  }

  if (decision.outcome === "mask" && decision.maskedText) {
    return setChunkText(args.part, decision.maskedText);
  }

  // allow / warn / require_approval (enforcePostprocess will throw on
  // require_approval, so by the time we get here it's allow or warn)
  return args.part;
}

function isTextPart(part: MastraStreamChunk): boolean {
  if (typeof part?.payload?.text === "string") return true;
  // Fallback: Mastra sometimes uses type strings like "text-delta".
  return part?.type === "text-delta" || part?.type === "text";
}

function extractChunkText(part: MastraStreamChunk): string {
  if (!part) return "";
  if (typeof part.payload?.text === "string") return part.payload.text;
  const maybeDelta = (part as { delta?: unknown }).delta;
  if (typeof maybeDelta === "string") return maybeDelta;
  if (maybeDelta && typeof maybeDelta === "object" && "text" in maybeDelta) {
    const d = maybeDelta as { text?: string };
    if (typeof d.text === "string") return d.text;
  }
  return "";
}

function setChunkText(
  part: MastraStreamChunk,
  newText: string,
): MastraStreamChunk {
  // Preserve shape — clone the chunk and overwrite whichever text field
  // was populated.
  const next: MastraStreamChunk = { ...part, payload: { ...(part.payload ?? {}) } };
  if (typeof part.payload?.text === "string") {
    next.payload = { ...(part.payload ?? {}), text: newText };
    return next;
  }
  const maybeDelta = (part as { delta?: unknown }).delta;
  if (typeof maybeDelta === "string") {
    (next as { delta?: string }).delta = newText;
    return next;
  }
  if (maybeDelta && typeof maybeDelta === "object" && "text" in maybeDelta) {
    (next as { delta?: Record<string, unknown> }).delta = {
      ...(maybeDelta as Record<string, unknown>),
      text: newText,
    };
    return next;
  }
  // Last resort — put the masked text on payload.text.
  next.payload = { ...(part.payload ?? {}), text: newText };
  return next;
}
