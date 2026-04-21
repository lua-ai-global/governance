/**
 * Shared postprocess streaming helper for framework adapters.
 *
 * Adapters that expose a streaming LLM call (Vercel AI `streamText`, Anthropic
 * `messages.stream`, LangChain `.stream()`, Mastra processor output stream,
 * etc.) route their chunk stream through `enforcePostprocessStream` so that
 * governance post-scan happens consistently without each adapter reinventing
 * chunk buffering, masking, or block semantics.
 *
 * ## Modes
 *
 *   - `buffered` (default, safest)
 *     Accumulate the full stream, run postprocess once on the complete text,
 *     then flush all chunks. Breaks live streaming UX but guarantees every
 *     rule fires over the complete output. Equivalent to non-streaming.
 *
 *   - `sliding`
 *     Hold back the last N chunks (or N characters) so we always have a
 *     lookback window to catch patterns that straddle chunk boundaries
 *     (e.g. a partial SSN split across two tokens). Flush chunk i only
 *     after chunk i+N arrives and passes scan. Near-live UX with a small
 *     delay; catches most cross-chunk patterns.
 *
 *   - `per-chunk`
 *     Scan each chunk in isolation, flush immediately. Fastest; weakest —
 *     cross-chunk patterns are missed. Use only when policies are
 *     self-contained per chunk (e.g. per-token toxicity classifiers).
 *
 * ## Block semantics
 *
 * If postprocess blocks (or require_approval), the returned iterable throws
 * a `GovernanceBlockedError` / `GovernanceApprovalRequiredError`. Any chunks
 * already flushed to the consumer are gone — adapters document this up front.
 *
 * ## Mask semantics
 *
 *   - `buffered`: all chunks flushed as one masked blob at the end. If the
 *     adapter needs per-chunk flushing, use `sliding` or `per-chunk`.
 *   - `sliding`: the outgoing (flushed) window is scanned on every slide.
 *     On mask, the held-back chunks are replaced by a single chunk carrying
 *     the masked text before flushing.
 *   - `per-chunk`: each chunk scanned independently; mask replaces its text.
 */

import type { GovernanceInstance } from "../index";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePostprocess } from "./pre-post-enforce.js";
import type { PrePostEnforceOptions } from "./pre-post-enforce.js";

/**
 * Generate a stable stream id. Every enforce() call for a single LLM
 * stream carries the same id in metadata so the dashboard can collapse
 * N per-chunk rows into one logical "operation" for reviewers. Zero-dep
 * UUIDv4 fallback mirrors the one in supply-chain-cyclonedx.ts so the
 * SDK's "no runtime deps" rule stays intact.
 */
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
 * Merge a streamId + slice index into the options.metadata for each
 * per-chunk enforce call. Preserves any caller-supplied metadata.
 */
function withStreamMeta<O extends PrePostEnforceOptions>(
  options: O,
  streamId: string,
  sliceIndex: number,
): O {
  return {
    ...options,
    metadata: {
      ...(options.metadata ?? {}),
      streamId,
      streamSlice: sliceIndex,
    },
  };
}

// ─── Types ────────────────────────────────────────────────────

export type StreamMode = "buffered" | "sliding" | "per-chunk";

export interface StreamEnforceOptions<ChunkT> extends PrePostEnforceOptions {
  /** One of "buffered" | "sliding" | "per-chunk". Default "buffered". */
  streamMode?: StreamMode;
  /** Sliding mode only — number of chunks to hold back. Default 2. */
  streamLookbackChunks?: number;
  /**
   * Sliding mode only — minimum characters to hold back. Overrides
   * streamLookbackChunks when the char count of pending chunks exceeds
   * this value. Default: no char-based limit.
   */
  streamLookbackChars?: number;
  /** Extract scannable text from a chunk. Required. */
  extractText: (chunk: ChunkT) => string;
  /**
   * Build a replacement chunk carrying masked text. Called when postprocess
   * returns a `mask` outcome and the adapter needs to emit the redacted
   * version downstream. If omitted, masked chunks fall back to the original
   * chunks unmodified — the callback-level onMask is still invoked, so
   * adapters that prefer to handle masking out-of-band can do so.
   */
  buildMaskedChunk?: (originalChunk: ChunkT, maskedText: string) => ChunkT;
}

// ─── Main Export ──────────────────────────────────────────────

/**
 * Wrap a chunk stream with governance postprocess enforcement.
 *
 * Returns an async iterable that yields the same chunks (possibly masked,
 * possibly held back depending on mode) and throws if the stream is blocked.
 */
export async function* enforcePostprocessStream<ChunkT>(
  governance: GovernanceInstance,
  source: AsyncIterable<ChunkT>,
  options: StreamEnforceOptions<ChunkT>,
): AsyncIterable<ChunkT> {
  const mode: StreamMode = options.streamMode ?? "buffered";
  // One id per stream — every enforce call this helper triggers carries
  // it in metadata so the cloud dashboard can collapse repeated rows
  // into a single logical operation. Buffered mode also tags its single
  // call so buffered-vs-per-chunk audit shape is consistent.
  const streamId = generateStreamId();

  if (mode === "buffered") {
    yield* runBuffered(governance, source, options, streamId);
    return;
  }
  if (mode === "per-chunk") {
    yield* runPerChunk(governance, source, options, streamId);
    return;
  }
  yield* runSliding(governance, source, options, streamId);
}

// ─── Buffered mode ────────────────────────────────────────────

async function* runBuffered<ChunkT>(
  governance: GovernanceInstance,
  source: AsyncIterable<ChunkT>,
  options: StreamEnforceOptions<ChunkT>,
  streamId: string,
): AsyncIterable<ChunkT> {
  const chunks: ChunkT[] = [];
  const texts: string[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
    texts.push(options.extractText(chunk));
  }

  const combined = texts.join("");
  if (!combined) {
    for (const c of chunks) yield c;
    return;
  }

  const result = await enforcePostprocess(governance, combined, {
    ...withStreamMeta(options, streamId, 0),
    toolName: options.toolName ?? "stream:buffered",
  });

  // If post-scan didn't change anything, flush chunks as-is.
  if (result.text === combined) {
    for (const c of chunks) yield c;
    return;
  }

  // On mask, emit a single replacement chunk if the adapter supplied a
  // builder; otherwise emit original chunks (the onMask callback has already
  // fired via handleOutcome so the adapter knows about the masked text).
  if (options.buildMaskedChunk && chunks.length > 0) {
    yield options.buildMaskedChunk(chunks[0], result.text);
    return;
  }
  for (const c of chunks) yield c;
}

// ─── Per-chunk mode ───────────────────────────────────────────

async function* runPerChunk<ChunkT>(
  governance: GovernanceInstance,
  source: AsyncIterable<ChunkT>,
  options: StreamEnforceOptions<ChunkT>,
  streamId: string,
): AsyncIterable<ChunkT> {
  let sliceIndex = 0;
  for await (const chunk of source) {
    const text = options.extractText(chunk);
    if (!text) {
      yield chunk;
      continue;
    }

    const result = await enforcePostprocess(governance, text, {
      ...withStreamMeta(options, streamId, sliceIndex++),
      toolName: options.toolName ?? "stream:per-chunk",
    });

    if (result.text === text) {
      yield chunk;
      continue;
    }
    yield options.buildMaskedChunk
      ? options.buildMaskedChunk(chunk, result.text)
      : chunk;
  }
}

// ─── Sliding mode ─────────────────────────────────────────────

async function* runSliding<ChunkT>(
  governance: GovernanceInstance,
  source: AsyncIterable<ChunkT>,
  options: StreamEnforceOptions<ChunkT>,
  streamId: string,
): AsyncIterable<ChunkT> {
  const window: ChunkT[] = [];
  const windowTexts: string[] = [];
  const lookbackChunks = options.streamLookbackChunks ?? 2;
  const lookbackChars = options.streamLookbackChars;
  const sliceCounter = { value: 0 };

  for await (const chunk of source) {
    window.push(chunk);
    windowTexts.push(options.extractText(chunk));

    while (shouldFlush(window.length, windowTexts, lookbackChunks, lookbackChars)) {
      yield* flushOldest(governance, window, windowTexts, options, streamId, sliceCounter);
    }
  }

  // Stream ended — drain the remaining window as one final scan so cross-chunk
  // patterns at the tail still catch.
  if (window.length === 0) return;
  const tailText = windowTexts.join("");
  if (!tailText) {
    for (const c of window) yield c;
    return;
  }
  const result = await enforcePostprocess(governance, tailText, {
    ...withStreamMeta(options, streamId, sliceCounter.value++),
    toolName: options.toolName ?? "stream:sliding-tail",
  });
  if (result.text === tailText) {
    for (const c of window) yield c;
    return;
  }
  if (options.buildMaskedChunk && window.length > 0) {
    yield options.buildMaskedChunk(window[0], result.text);
    return;
  }
  for (const c of window) yield c;
}

function shouldFlush(
  windowLen: number,
  windowTexts: string[],
  lookbackChunks: number,
  lookbackChars: number | undefined,
): boolean {
  if (windowLen > lookbackChunks) return true;
  if (lookbackChars != null) {
    let chars = 0;
    for (const t of windowTexts) chars += t.length;
    if (chars > lookbackChars) return true;
  }
  return false;
}

async function* flushOldest<ChunkT>(
  governance: GovernanceInstance,
  window: ChunkT[],
  windowTexts: string[],
  options: StreamEnforceOptions<ChunkT>,
  streamId: string,
  sliceCounter: { value: number },
): AsyncIterable<ChunkT> {
  // Scan the full lookback window (oldest + lookback tail) before flushing
  // the oldest chunk. This gives the scanner context straddling boundaries.
  const scanText = windowTexts.join("");
  if (!scanText) {
    const oldest = window.shift()!;
    windowTexts.shift();
    yield oldest;
    return;
  }

  const result = await enforcePostprocess(governance, scanText, {
    ...withStreamMeta(options, streamId, sliceCounter.value++),
    toolName: options.toolName ?? "stream:sliding",
  });

  const oldest = window.shift()!;
  const oldestText = windowTexts.shift()!;

  if (result.text === scanText) {
    yield oldest;
    return;
  }

  // Mask outcome: collapse the entire held window into a single masked chunk
  // and emit it now, clearing the window so we don't double-scan.
  if (options.buildMaskedChunk) {
    yield options.buildMaskedChunk(oldest, result.text);
    window.length = 0;
    windowTexts.length = 0;
    return;
  }
  // No masked-chunk builder — yield the oldest as-is; callback-level onMask
  // has already fired inside enforcePostprocess.
  yield oldest;
  // Suppress: oldestText unused outside this scope
  void oldestText;
}
