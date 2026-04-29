/**
 * Mastra tool-wrapping for governance.
 *
 * Why this exists: Mastra's Processor lifecycle has no hook between a tool's
 * `execute()` returning and the LLM ingesting the result on the next turn.
 * That gap is where prompt-injection from external content (file contents,
 * clipboard, scraped pages) lands today, unscanned. This module closes it
 * by wrapping each tool's `execute()` at construction time — the wrapper
 * runs the original tool, then runs the result through `scanToolResult()`
 * (the shared signal-then-enforce helper) before returning.
 *
 * Integrators apply the wrapper through:
 *   - `processor.wrapTool(tool)` — single tool
 *   - `processor.wrapTools({ name: tool, ... })` — bulk
 *
 * If/when Mastra core grows a `processToolResult` lifecycle hook, this module
 * stays as the backwards-compat shim — both paths call the same
 * `scanToolResult()`, so swapping is one line.
 */

import type { GovernanceInstance } from "../index.js";
import { scanToolResult } from "../tool-result-scan.js";

// ─── Types ────────────────────────────────────────────────────

/**
 * Per-tool mapping of input arg names to EnforcementContext fields.
 *
 * Without this, rules like `scope_boundary: { allowedPaths }` and
 * `network_allowlist: { allowedDomains }` silently never fire — the
 * engine reads `ctx.targetPath` / `ctx.targetUrl`, not raw `args.path`.
 *
 * Keys are tool names (Mastra `tool.id`). Values are arg-name → ctx-field
 * mappings. Generic defaults cover the common shapes (`path` → `targetPath`,
 * `url` → `targetUrl`) so most tools work without an explicit entry.
 *
 * @example
 * ```ts
 * const registry: ToolFieldExtractionRegistry = {
 *   "device__lua_desktop__read_file":  { path: "targetPath" },
 *   "device__lua_desktop__write_file": { path: "targetPath" },
 *   "fetch":                            { url: "targetUrl" },
 * };
 * ```
 */
export type ToolFieldExtractionRegistry = Record<string, ToolFieldMap>;

export interface ToolFieldMap {
  /** Optional — name of the arg holding the file/resource path. */
  [argName: string]: "targetPath" | "targetUrl";
}

/**
 * Generic field-extraction defaults applied when a tool isn't explicitly
 * registered. Covers the common arg-name conventions across MCP, Vercel AI
 * SDK, LangChain, and our own device tools.
 */
const DEFAULT_FIELD_NAMES: ToolFieldMap = {
  path: "targetPath",
  filePath: "targetPath",
  file_path: "targetPath",
  filepath: "targetPath",
  url: "targetUrl",
  href: "targetUrl",
  uri: "targetUrl",
  endpoint: "targetUrl",
};

/** Minimal Mastra Tool shape — just the bits we need to wrap. */
export interface MastraTool<TInput = unknown, TOutput = unknown> {
  id: string;
  description?: string;
  execute: (input: TInput, ...rest: unknown[]) => Promise<TOutput> | TOutput;
  [extra: string]: unknown;
}

export interface WrapToolOptions {
  governance: GovernanceInstance;
  agentId: string;
  agentName?: string;
  agentLevel?: number;
  /** Per-tool registry — overrides defaults when present. */
  toolFieldExtraction?: ToolFieldExtractionRegistry;
  /** Detection threshold for the local injection signal. Default 0.5. */
  injectionThreshold?: number;
  /** Per-tool override: skip wrapping entirely when set to `"never"`. */
  toolResultScans?: Record<string, "always" | "never">;
  /** Static metadata merged into every enforce call's ctx.metadata. */
  metadata?: Record<string, unknown>;
}

// ─── Field extraction ─────────────────────────────────────────

/**
 * Pull `targetPath` / `targetUrl` off a tool's input args based on the
 * registry plus the generic name conventions. Tool-specific entries win
 * over defaults; the first matching arg wins on conflict.
 */
export function extractFields(
  args: Record<string, unknown> | undefined,
  registry: ToolFieldExtractionRegistry | undefined,
  toolName: string,
): { targetPath?: string; targetUrl?: string } {
  if (!args) return {};
  const out: { targetPath?: string; targetUrl?: string } = {};

  // Tool-specific registry first (explicit > implicit).
  const toolMap = registry?.[toolName];
  if (toolMap) {
    for (const [arg, field] of Object.entries(toolMap)) {
      const v = args[arg];
      if (typeof v === "string") {
        if (field === "targetPath" && !out.targetPath) out.targetPath = v;
        if (field === "targetUrl" && !out.targetUrl) out.targetUrl = v;
      }
    }
  }

  // Generic name conventions for fields not yet populated.
  for (const [arg, field] of Object.entries(DEFAULT_FIELD_NAMES)) {
    if (out.targetPath && out.targetUrl) break;
    const v = args[arg];
    if (typeof v !== "string") continue;
    if (field === "targetPath" && !out.targetPath) out.targetPath = v;
    if (field === "targetUrl" && !out.targetUrl) out.targetUrl = v;
  }

  return out;
}

// ─── Wrap helpers ─────────────────────────────────────────────

/**
 * Wrap a single Mastra Tool with governance scanning on its result. The
 * returned tool is a shallow copy of the input with `execute` replaced —
 * preserves all other fields (description, inputSchema, retry config, etc.).
 *
 * Substitution behaviour on block: the wrapped `execute` returns
 * `{ blocked: true, reason, ruleId }` instead of the original output.
 * The LLM sees the substitute and adapts on its next turn.
 */
export function wrapToolWithGovernance<T extends MastraTool>(
  tool: T,
  opts: WrapToolOptions,
): T {
  // Per-tool opt-out
  if (opts.toolResultScans?.[tool.id] === "never") {
    return tool;
  }

  const originalExecute = tool.execute.bind(tool);
  const fieldExtraction = opts.toolFieldExtraction;
  const threshold = opts.injectionThreshold ?? 0.5;

  // Replace execute with a scanning closure. We preserve all other tool
  // fields by spreading; this also keeps the tool type-compatible with
  // Mastra's Tool class (structural typing).
  const wrapped = {
    ...tool,
    execute: async (input: unknown, ...rest: unknown[]): Promise<unknown> => {
      const result = await originalExecute(input as never, ...rest);

      const args = isRecord(input) ? input : undefined;
      const fields = extractFields(args, fieldExtraction, tool.id);

      const scan = await scanToolResult({
        governance: opts.governance,
        agentId: opts.agentId,
        agentName: opts.agentName,
        agentLevel: opts.agentLevel,
        tool: tool.id,
        args,
        result,
        fields,
        metadata: opts.metadata,
        injectionThreshold: threshold,
      });

      return scan.result;
    },
  };

  return wrapped as T;
}

/**
 * Wrap every tool in a tools dict. Useful for the typical Mastra agent
 * config shape where tools is a `Record<string, Tool>`.
 */
export function wrapToolsWithGovernance<T extends Record<string, MastraTool>>(
  tools: T,
  opts: WrapToolOptions,
): T {
  const out: Record<string, MastraTool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = wrapToolWithGovernance(tool, opts);
  }
  return out as T;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
