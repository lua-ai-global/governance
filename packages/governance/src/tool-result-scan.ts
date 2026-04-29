/**
 * Tool-result scanning — shared across framework adapters.
 *
 * The threat model: a tool's return value (file contents, clipboard text,
 * scraped page, MCP server response) becomes input to the next LLM turn.
 * Untrusted external content can carry prompt injection or sensitive data
 * that should never reach the LLM context.
 *
 * This helper does the signal-then-enforce dance:
 *
 *   1. Extract scannable text from the tool's result (any shape)
 *   2. Run detectInjection() locally to populate ctx.mlInjectionScore
 *      (the host's signal — required in local mode, redundant in cloud mode
 *      where DeBERTa preflight will populate the same field server-side)
 *   3. Build an EnforcementContext at stage "tool_result" with the signal
 *      and any pre-extracted fields (targetPath, targetUrl) so engine rules
 *      that depend on them actually fire
 *   4. Call governance.enforce() — the policy engine is the sole
 *      decision-maker, evaluating every applicable rule at this stage
 *      (ml_injection_guard, sensitive_data_filter, output_pattern,
 *      scope_boundary, composites, kill switch)
 *   5. Substitute a redacted detail object on block; pass through on allow
 *
 * Used by:
 *   - The Mastra `wrapTool` helper (plugins/mastra-processor-tool-wrap.ts)
 *   - The MCP adapter's tool-output scan (plugins/mcp.ts) — replaces the
 *     legacy inline detectInjection() call
 *   - Any future framework adapter that intercepts tool returns
 */

import type { GovernanceInstance } from "./index.js";
import type { EnforcementContext, EnforcementDecision } from "./policy.js";
import { detectInjection } from "./injection-detect.js";

/**
 * Redacted result returned to the LLM in place of blocked content.
 * Matches the shape used by `gov.enforce()` in its decision payload so
 * downstream code has a consistent vocabulary to handle blocks.
 */
export interface BlockedToolResult {
  blocked: true;
  reason: string;
  ruleId: string | null;
}

export interface ScanToolResultInput {
  governance: GovernanceInstance;
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  /** Tool identifier — matches `EnforcementContext.tool`. */
  tool: string;
  /** Optional call id from the framework. */
  toolCallId?: string;
  /** Args the LLM passed to the tool. */
  args?: Record<string, unknown>;
  /** What the tool's `execute()` returned. Any shape — text is extracted. */
  result: unknown;
  /**
   * Pre-extracted fields to populate on the context. Without these, rules
   * like `scope_boundary` and `network_allowlist` silently never fire.
   * Adapters compute these from `args` using a tool-field-extraction registry.
   */
  fields?: {
    targetPath?: string;
    targetUrl?: string;
  };
  /** Per-call metadata to merge into ctx.metadata. */
  metadata?: Record<string, unknown>;
  /** Detection threshold for the local injection signal. Default 0.5. */
  injectionThreshold?: number;
  /**
   * Skip local detectInjection signal generation. Useful when the host has
   * already populated `mlInjectionScore` from its own classifier (e.g. a
   * cloud preflight) and the local regex baseline would only add noise.
   */
  skipInjectionSignal?: boolean;
}

export interface ScanToolResultOutput {
  /** Engine decision — for audit and downstream handling. */
  decision: EnforcementDecision;
  /**
   * The value the caller should return from the wrapped tool. Equal to
   * the original `result` on allow / warn / mask passthrough; equal to a
   * `BlockedToolResult` on block / require_approval (LLM never sees the
   * original content).
   */
  result: unknown;
  /** True when the result was substituted with a `BlockedToolResult`. */
  blocked: boolean;
}

/**
 * Flatten any tool-result value to a single scannable string. The injection
 * detector and most policy conditions operate on text, so we walk the value
 * collecting strings and concatenate them.
 *
 * Handles:
 *   - Plain strings
 *   - Arrays (recursive)
 *   - Objects with text/content fields (recursive)
 *   - MCP-style `{ content: [{ type: "text", text: string }] }`
 *   - Mixed primitive/object payloads
 */
export function extractScannableText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const parts: string[] = [];
  const seen = new WeakSet<object>();

  (function walk(v: unknown): void {
    if (v == null) return;
    if (typeof v === "string") {
      parts.push(v);
      return;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      parts.push(String(v));
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) walk(val);
  })(value);

  return parts.join("\n");
}

/**
 * Scan a tool's return value through the governance policy engine at stage
 * `tool_result`. Returns the value the wrapping adapter should return to the
 * caller (original on allow, redacted detail on block).
 */
export async function scanToolResult(input: ScanToolResultInput): Promise<ScanToolResultOutput> {
  const text = extractScannableText(input.result);

  // ─── Signal generation (local mode) ────────────────────────────
  let mlInjectionScore: number | undefined;
  let mlInjectionCategories: string[] | undefined;
  if (!input.skipInjectionSignal && text.length > 0) {
    const scan = detectInjection(text, {
      threshold: input.injectionThreshold ?? 0.5,
    });
    mlInjectionScore = scan.score;
    mlInjectionCategories = scan.categories.length > 0 ? [...scan.categories] : undefined;
  }

  // ─── Build context for the engine ──────────────────────────────
  const ctx: EnforcementContext = {
    agentId: input.agentId,
    agentName: input.agentName,
    agentLevel: input.agentLevel,
    action: "tool_call",
    tool: input.tool,
    input: input.args,
    outputText: text,
    mlInjectionScore,
    mlInjectionCategories,
    targetPath: input.fields?.targetPath,
    targetUrl: input.fields?.targetUrl,
    metadata: input.metadata,
  };

  // ─── Enforce — engine is the sole decision-maker ───────────────
  // We use `enforce()` (which evaluates all stages) and rely on rule-level
  // `stage: "tool_result"` filtering. If the host has set
  // `governance.enforceToolResult` we'd prefer that, but enforce() works
  // identically because tool_result-default conditions only match here.
  const govWithStage = input.governance as GovernanceInstance & {
    enforceToolResult?: (ctx: EnforcementContext) => Promise<EnforcementDecision>;
  };
  const decision = govWithStage.enforceToolResult
    ? await govWithStage.enforceToolResult(ctx)
    : await input.governance.enforce(ctx);

  // ─── Substitute on block / require_approval ────────────────────
  if (decision.blocked || decision.outcome === "require_approval") {
    const blocked: BlockedToolResult = {
      blocked: true,
      reason: decision.reason,
      ruleId: decision.ruleId,
    };
    return { decision, result: blocked, blocked: true };
  }

  // mask outcome — substitute the masked text into a structurally similar
  // shape if the original was a string; otherwise pass through. Callers can
  // inspect `decision.maskedText` for finer-grained handling.
  if (decision.outcome === "mask" && decision.maskedText !== undefined && typeof input.result === "string") {
    return { decision, result: decision.maskedText, blocked: false };
  }

  // allow / warn — pass through unchanged
  return { decision, result: input.result, blocked: false };
}
