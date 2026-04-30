/**
 * governance-sdk — Multi-Modal Scan Orchestration
 *
 * The SDK's injection cascade scans text. Image, PDF, and audio content
 * blocks pass through it untouched unless something extracts text first.
 * This file ships the orchestration; the actual extractors (OCR, PDF
 * parsing, ASR) are caller-supplied via `registerModalityScanner` so
 * the SDK stays zero-runtime-dep.
 *
 * **Opt-in by default.** Every modality except `text` is OFF unless the
 * caller enables it explicitly. Reasons:
 *   - Cost: OCR / Whisper inference per request is non-trivial.
 *   - Latency: extraction adds 100ms–10s depending on payload + tool.
 *   - Privacy: some customers cannot have payload content read by
 *     anything other than the model itself.
 *
 * **Wiring with the existing cascade:**
 *   1. Caller registers extractors at startup:
 *      `registerModalityScanner('image', { extractText: ... })`
 *   2. Per request, caller invokes `scanMultiModal(blocks, { enabled: ['text','image'] })`
 *      BEFORE `gov.enforce()`.
 *   3. The returned `text` is the concatenation of all scanned blocks. Run
 *      it through `detectInjection()` / `hybridDetect()` and populate
 *      `ctx.mlInjectionScore` as usual.
 *   4. If `result.blocked.length > 0`, treat as fail-closed (set the score
 *      to 1.0 or block out-of-band). The SDK does not auto-block — it
 *      surfaces the failure so policy can decide.
 *
 * Mirrors the InjectionClassifier pattern in `injection-classifier.ts` —
 * same async hook + global registry + pre-`enforce()` invocation shape.
 */

// ─── Types ───────────────────────────────────────────────────────

/** Recognised content modalities. */
export type Modality = "text" | "image" | "pdf" | "audio";

/**
 * Pluggable scanner that converts a non-text block into text the
 * cascade can scan. Implementations are caller-supplied so the SDK has
 * zero runtime deps on Tesseract / pdf-parse / Whisper / vision LLMs.
 */
export interface ModalityScanner {
  /**
   * Extract scannable text from `block`. Return `null` if the block has
   * no extractable text (e.g. an image that's purely visual). Throw or
   * reject to signal a failure that the orchestrator should classify as
   * an unscannable block.
   */
  extractText(block: unknown): Promise<string | null>;
}

/**
 * One block of content in a possibly-multi-modal payload. The orchestrator
 * uses `modality` to pick the registered scanner; `text` is consumed
 * directly when `modality === 'text'`; `data` is opaque and forwarded to
 * the scanner for everything else.
 */
export interface ContentBlock {
  modality: Modality;
  /** Used directly when `modality === 'text'`. Ignored otherwise. */
  text?: string;
  /** Forwarded to the registered scanner for non-text modalities. */
  data?: unknown;
}

/**
 * What the orchestrator did and didn't manage to scan. Callers should
 * fail-closed if `blocked.length > 0`.
 */
export interface MultiModalScanResult {
  /** Concatenation of all extracted text, separated by `\n\n`. */
  text: string;
  /** Modalities for which at least one block was scanned successfully. */
  modalitiesScanned: Modality[];
  /**
   * Blocks that were intentionally not scanned because their modality
   * was not in the enabled set. Not a failure — informational.
   */
  modalitiesSkipped: { modality: Modality; reason: "not_enabled" }[];
  /**
   * Blocks the orchestrator could not scan: enabled-but-no-scanner,
   * scanner threw, scanner timed out, or scanner returned null. Treat
   * as fail-closed when `onMissingScanner` or `onExtractError` is `'block'`.
   */
  blocked: {
    modality: Modality;
    reason: "no_scanner" | "extract_error" | "extract_timeout" | "extract_empty";
    detail?: string;
  }[];
  /** Wall-clock time spent in scanners + orchestration. */
  durationMs: number;
}

/** Options controlling modality opt-in and failure-mode policy. */
export interface ScanOptions {
  /**
   * Modalities to scan this call. Default: `['text']`. Opt in to anything
   * else explicitly. Accepts an array or a Set.
   */
  enabled?: readonly Modality[] | ReadonlySet<Modality>;
  /**
   * What to do when an enabled modality has no registered scanner:
   *   - `'skip'` (default): drop the block, record in `blocked[]` with
   *     reason `no_scanner`.
   *   - `'block'`: same plus the caller should treat the result as fail-closed.
   *
   * Both modes record the block; the difference is callers' interpretation.
   * The orchestrator never throws — it surfaces the situation so policy
   * can decide.
   */
  onMissingScanner?: "skip" | "block";
  /**
   * What to do when a scanner throws or rejects. Same shape as
   * `onMissingScanner`. Default: `'skip'`.
   */
  onExtractError?: "skip" | "block";
  /**
   * Per-block extraction timeout in ms. Default 30_000. Timeouts count
   * as `extract_timeout` in `blocked[]`.
   */
  timeoutMs?: number;
}

// ─── Registry ────────────────────────────────────────────────────

const scanners = new Map<Modality, ModalityScanner>();

/**
 * Register an extractor for a modality. Replaces any existing scanner
 * for that modality. Call once at startup (or per-tenant if you need
 * per-tenant extractors — wrap the call yourself).
 */
export function registerModalityScanner(
  modality: Modality,
  scanner: ModalityScanner,
): void {
  scanners.set(modality, scanner);
}

/** Look up the registered scanner for a modality (or null). */
export function getModalityScanner(modality: Modality): ModalityScanner | null {
  return scanners.get(modality) ?? null;
}

/** Remove a single scanner registration. No-op if none registered. */
export function unregisterModalityScanner(modality: Modality): void {
  scanners.delete(modality);
}

/** Wipe all registrations. Mainly for tests. */
export function clearModalityScanners(): void {
  scanners.clear();
}

/** True if any non-text scanner is registered. */
export function hasModalityScanner(modality: Modality): boolean {
  return scanners.has(modality);
}

// ─── Orchestrator ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ENABLED: readonly Modality[] = ["text"];

function toEnabledSet(
  enabled: ScanOptions["enabled"] | undefined,
): ReadonlySet<Modality> {
  if (!enabled) return new Set(DEFAULT_ENABLED);
  if (enabled instanceof Set) return enabled;
  return new Set(enabled);
}

type RaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; detail: string };

/**
 * Race a promise against a timeout. Catches both rejections and timeouts
 * so the caller never sees an unhandled rejection from a scanner.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<RaceResult<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<RaceResult<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: "timeout" }),
      ms,
    );
  });
  const wrapped: Promise<RaceResult<T>> = p.then(
    (value) => ({ ok: true, value }),
    (err: unknown) => ({
      ok: false,
      reason: "error",
      detail: err instanceof Error ? err.message : String(err),
    }),
  );
  try {
    return await Promise.race([wrapped, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Walk `blocks` and produce a single concatenated text payload along with
 * structured per-block scan results. Returns even when individual blocks
 * fail — `blocked[]` is the source of truth for fail-closed decisions.
 */
export async function scanMultiModal(
  blocks: readonly ContentBlock[],
  options: ScanOptions = {},
): Promise<MultiModalScanResult> {
  const startedAt = Date.now();
  const enabled = toEnabledSet(options.enabled);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const extractedTexts: string[] = [];
  const scannedSet = new Set<Modality>();
  const skipped: MultiModalScanResult["modalitiesSkipped"] = [];
  const blocked: MultiModalScanResult["blocked"] = [];

  for (const block of blocks) {
    const { modality } = block;

    if (!enabled.has(modality)) {
      skipped.push({ modality, reason: "not_enabled" });
      continue;
    }

    if (modality === "text") {
      if (typeof block.text === "string" && block.text.length > 0) {
        extractedTexts.push(block.text);
        scannedSet.add("text");
      }
      continue;
    }

    const scanner = scanners.get(modality);
    if (!scanner) {
      blocked.push({
        modality,
        reason: "no_scanner",
        detail: `No scanner registered for modality '${modality}'`,
      });
      continue;
    }

    let extractPromise: Promise<string | null>;
    try {
      extractPromise = scanner.extractText(block.data);
    } catch (err) {
      // Synchronous throw from the scanner. Treat as extract_error.
      blocked.push({
        modality,
        reason: "extract_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const raced = await withTimeout(extractPromise, timeoutMs);

    if (!raced.ok) {
      if (raced.reason === "timeout") {
        blocked.push({
          modality,
          reason: "extract_timeout",
          detail: `Scanner exceeded ${timeoutMs}ms`,
        });
      } else {
        blocked.push({
          modality,
          reason: "extract_error",
          detail: raced.detail,
        });
      }
      continue;
    }

    const value = raced.value;
    if (value === null || value === undefined) {
      blocked.push({
        modality,
        reason: "extract_empty",
        detail: "Scanner returned no text",
      });
      continue;
    }

    if (typeof value !== "string") {
      blocked.push({
        modality,
        reason: "extract_error",
        detail: `Scanner returned non-string value: ${typeof value}`,
      });
      continue;
    }

    if (value.length > 0) extractedTexts.push(value);
    scannedSet.add(modality);
  }

  return {
    text: extractedTexts.join("\n\n"),
    modalitiesScanned: Array.from(scannedSet),
    modalitiesSkipped: skipped,
    blocked,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * True if the scan result requires fail-closed treatment given the policy
 * options. Mirrors the orchestrator's classification: `blocked[]` rows are
 * fatal when the corresponding option is `'block'`.
 */
export function isFailClosed(
  result: MultiModalScanResult,
  options: Pick<ScanOptions, "onMissingScanner" | "onExtractError"> = {},
): boolean {
  const onMissing = options.onMissingScanner ?? "skip";
  const onError = options.onExtractError ?? "skip";

  for (const b of result.blocked) {
    if (b.reason === "no_scanner" && onMissing === "block") return true;
    if (b.reason !== "no_scanner" && onError === "block") return true;
  }
  return false;
}
