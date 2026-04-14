/**
 * governance-sdk Vercel AI — wrapStream (postprocess streaming)
 *
 * The `createGovernanceMiddleware` base implements transformParams (pre) and
 * wrapGenerate (non-streaming post). Streaming post-scan is handled here so
 * the base middleware file stays under the 300-LOC cap.
 *
 * Vercel AI's middleware contract for streaming:
 *
 *   wrapStream({ doStream, params }) → Promise<{ stream, ... }>
 *
 * where `stream` is a `ReadableStream<LanguageModelV2StreamPart>`. Text parts
 * have shape `{ type: 'text-delta', delta: string }`. We route the stream
 * through `enforcePostprocessStream`, scanning text-delta parts while
 * passing non-text parts (tool-call, finish, etc.) through untouched.
 */

import type { GovernanceInstance } from "../index";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { enforcePostprocessStream } from "./pre-post-stream.js";
import type { StreamMode } from "./pre-post-stream.js";

// ─── Types ──────────────────────────────────────────────────────

/** Minimal shape of a LanguageModelV2 stream part we care about. */
export interface VercelStreamPart {
  type: string;
  delta?: string;
  [k: string]: unknown;
}

export interface VercelStreamResult {
  stream: ReadableStream<VercelStreamPart>;
  [key: string]: unknown;
}

export interface VercelStreamConfig extends OutcomeCallbacks {
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  /** Disable post-scan of streamed output (default: enabled). */
  postprocess?: boolean;
  metadata?: Record<string, unknown>;
  sessionTokenTracker?: () => number;
  /** Streaming mode: "buffered" | "sliding" | "per-chunk". Default "buffered". */
  streamMode?: StreamMode;
  /** Sliding mode: chunks to hold back (default 2). */
  streamLookbackChunks?: number;
  /** Sliding mode: chars to hold back (overrides chunk count if exceeded). */
  streamLookbackChars?: number;
}

// ─── wrapStream ────────────────────────────────────────────────

export function buildWrapStream(
  governance: GovernanceInstance,
  config: VercelStreamConfig,
): (options: {
  doStream: () => Promise<VercelStreamResult>;
  params: unknown;
}) => Promise<VercelStreamResult> {
  const callbacks: OutcomeCallbacks = config;

  return async ({ doStream }) => {
    const result = await doStream();
    const governedStream = wrapStreamWithGovernance(
      result.stream,
      governance,
      config,
      callbacks,
    );
    return { ...result, stream: governedStream };
  };
}

function wrapStreamWithGovernance(
  source: ReadableStream<VercelStreamPart>,
  governance: GovernanceInstance,
  config: VercelStreamConfig,
  callbacks: OutcomeCallbacks,
): ReadableStream<VercelStreamPart> {
  const reader = source.getReader();

  // Async iterable adapter over the ReadableStream's text-delta parts.
  // Non-text parts are buffered separately and re-emitted in original order.
  // To keep ordering correct under async scanning, we walk the source stream
  // once, split parts into (text, non-text), scan the text parts via
  // enforcePostprocessStream, and interleave back into the output stream.
  return new ReadableStream<VercelStreamPart>({
    async start(controller) {
      const textParts: VercelStreamPart[] = [];
      const schedule: Array<
        | { kind: "text"; index: number }
        | { kind: "passthrough"; part: VercelStreamPart }
      > = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === "text-delta" && typeof value.delta === "string") {
            schedule.push({ kind: "text", index: textParts.length });
            textParts.push(value);
          } else {
            schedule.push({ kind: "passthrough", part: value });
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }

      // Scan text parts through the shared streaming enforcer.
      if (!(config.postprocess ?? true) || textParts.length === 0) {
        for (const step of schedule) {
          if (step.kind === "text") controller.enqueue(textParts[step.index]);
          else controller.enqueue(step.part);
        }
        controller.close();
        return;
      }

      const scanned: VercelStreamPart[] = [];
      try {
        for await (const part of enforcePostprocessStream(
          governance,
          iterateArray(textParts),
          {
            agentId: config.agentId,
            agentName: config.agentName,
            agentLevel: config.agentLevel,
            metadata: config.metadata,
            sessionTokensUsed: config.sessionTokenTracker?.(),
            callbacks,
            toolName: "vercel.wrapStream",
            streamMode: config.streamMode,
            streamLookbackChunks: config.streamLookbackChunks,
            streamLookbackChars: config.streamLookbackChars,
            extractText: (p) => (typeof p.delta === "string" ? p.delta : ""),
            buildMaskedChunk: (orig, masked) => ({
              ...orig,
              delta: masked,
            }),
          },
        )) {
          scanned.push(part);
        }
      } catch (err) {
        controller.error(err);
        return;
      }

      // Re-interleave: replace each text-index slot with the next scanned
      // text part in order. If scanning collapsed text parts (buffered-mask
      // case emits one chunk for many), emit the remainder flat after the
      // passthrough sequence so nothing is lost.
      let scannedCursor = 0;
      for (const step of schedule) {
        if (step.kind === "passthrough") {
          controller.enqueue(step.part);
          continue;
        }
        if (scannedCursor < scanned.length) {
          controller.enqueue(scanned[scannedCursor++]);
        }
        // If we ran out of scanned parts early (collapse-to-one), silently
        // skip — the collapsed chunk already went through.
      }
      // Drain remainder (e.g. buffered mode yields 1 chunk total).
      while (scannedCursor < scanned.length) {
        controller.enqueue(scanned[scannedCursor++]);
      }
      controller.close();
    },
  });
}

async function* iterateArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}
