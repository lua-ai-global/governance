/**
 * governance-sdk — Sandbox module
 *
 * TWO separate primitives, clearly scoped:
 *
 * 1. `createSandbox()` — **action-gating policy**, not OS/process isolation.
 *    Emits policy rules that block disallowed action categories (e.g. `file_write`,
 *    `external_request`, `payment`) and enforces per-session quotas (tool calls,
 *    tokens, cost, duration). This is a governance layer — it does NOT run code.
 *
 * 2. `runInVmSandbox()` — real execution isolation using Node's built-in
 *    `node:vm` module. Runs untrusted JavaScript in a new V8 Context with a
 *    caller-controlled `globalThis`, wall-clock timeout, and no access to the
 *    host `require`/`process`/filesystem/network unless the caller explicitly
 *    injects them. Zero runtime dependencies — uses only `node:vm` (stdlib).
 *
 * `node:vm` is **not a security boundary** against a determined attacker who
 * controls the script (CVE-2023-32002-class escapes via `Object.getPrototypeOf`,
 * async loops, SharedArrayBuffer, etc. have all been demonstrated). Use it for
 * **isolation from accidental mistakes**, not for running genuinely adversarial
 * code. For that you need a separate OS process, a container, or `isolated-vm`.
 * Those belong in the host layer, not in a zero-dep TypeScript SDK.
 */

import { runInNewContext } from "node:vm";
import type { PolicyRule } from "./policy.js";

// ─── Types ───────────────────────────────────────────────────

export interface SandboxLevel {
  level: 0 | 1 | 2 | 3;
  label: string;
  description: string;
  allowedActions: string[];
}

export interface SandboxQuotas {
  maxToolCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

export interface SandboxConfig {
  level: 0 | 1 | 2 | 3;
  quotas?: SandboxQuotas;
  /** Policy priority for sandbox rules (default: 200) */
  priority?: number;
}

export interface SandboxState {
  level: SandboxLevel;
  toolCalls: number;
  tokensUsed: number;
  costUsd: number;
  startedAt: number;
}

export interface VmSandboxOptions {
  /** Wall-clock timeout in ms. Default 1000. The VM throws on timeout. */
  timeoutMs?: number;
  /** Globals injected into the sandbox's `globalThis`. No host globals leak in. */
  globals?: Record<string, unknown>;
  /** Human-readable filename for stack traces. Default `"sandbox.vm"`. */
  filename?: string;
}

export interface VmSandboxResult<T> {
  /** Result of the expression. Only set when `ok === true`. */
  value?: T;
  /** True if the script completed within the timeout without throwing. */
  ok: boolean;
  /** Error message if ok === false. */
  error?: string;
  /** Wall-clock duration the script ran for (ms). */
  durationMs: number;
  /** True if execution was cut off by the timeout. */
  timedOut: boolean;
}

// ─── Action-gating sandbox levels ────────────────────────────

export const SANDBOX_LEVELS: SandboxLevel[] = [
  {
    level: 0,
    label: "Unrestricted",
    description: "Full access — no action gating. Use only for trusted, high-governance agents.",
    allowedActions: ["tool_call", "message_send", "data_access", "external_request", "file_write", "database_mutation", "payment", "custom"],
  },
  {
    level: 1,
    label: "Read-Only",
    description: "Read operations only — no writes, mutations, or external requests.",
    allowedActions: ["tool_call", "message_send", "data_access"],
  },
  {
    level: 2,
    label: "Limited Write",
    description: "Read + limited writes — no external requests, payments, or database mutations.",
    allowedActions: ["tool_call", "message_send", "data_access", "file_write"],
  },
  {
    level: 3,
    label: "Full Action-Gated",
    description: "All local operations — external requests and payments require escalation.",
    allowedActions: ["tool_call", "message_send", "data_access", "file_write", "database_mutation", "custom"],
  },
];

// ─── createSandbox (action-gating policy) ────────────────────

export function createSandbox(config: SandboxConfig) {
  const { level, quotas = {}, priority = 200 } = config;
  const sandboxLevel = SANDBOX_LEVELS[level];
  const allowedActions = new Set(sandboxLevel.allowedActions);

  const state: SandboxState = {
    level: sandboxLevel,
    toolCalls: 0,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: Date.now(),
  };

  const levelRule: PolicyRule = {
    id: `sandbox-level-${level}`,
    name: `Sandbox: ${sandboxLevel.label} (Level ${level})`,
    condition: {
      type: "custom",
      params: {
        evaluate: (ctx: { action?: string }) => {
          return !!ctx.action && !allowedActions.has(ctx.action);
        },
      },
    },
    outcome: level === 0 ? "allow" : "block",
    reason: `Action not permitted in ${sandboxLevel.label} sandbox (level ${level})`,
    priority,
    enabled: level !== 0,
  };

  const quotaRule: PolicyRule = {
    id: `sandbox-quota-${level}`,
    name: `Sandbox: Quota enforcement (Level ${level})`,
    condition: {
      type: "custom",
      params: {
        evaluate: () => quotaExceeded(),
      },
    },
    outcome: "block",
    reason: "Session quota exceeded",
    priority: priority - 1,
    enabled: Object.keys(quotas).length > 0,
  };

  function quotaExceeded(): boolean {
    if (quotas.maxToolCalls && state.toolCalls >= quotas.maxToolCalls) return true;
    if (quotas.maxTokens && state.tokensUsed >= quotas.maxTokens) return true;
    if (quotas.maxCostUsd && state.costUsd >= quotas.maxCostUsd) return true;
    if (quotas.maxDurationMs && (Date.now() - state.startedAt) >= quotas.maxDurationMs) return true;
    return false;
  }

  return {
    levelRule,
    quotaRule,
    getState: (): Readonly<SandboxState> => ({ ...state }),
    recordToolCall: () => { state.toolCalls++; },
    recordTokens: (count: number) => { state.tokensUsed += count; },
    recordCost: (usd: number) => { state.costUsd += usd; },
    quotaExceeded,
    reset: () => { state.toolCalls = 0; state.tokensUsed = 0; state.costUsd = 0; state.startedAt = Date.now(); },
    getLevel: (): SandboxLevel => sandboxLevel,
    getAllLevels: (): SandboxLevel[] => [...SANDBOX_LEVELS],
  };
}

// ─── runInVmSandbox (execution isolation via node:vm) ────────

/**
 * Run an untrusted JavaScript expression in a fresh V8 Context with a wall-clock
 * timeout and no host globals unless injected.
 *
 * Use for **isolating policy expressions or rule DSL snippets** from the host
 * runtime. Not a security boundary against adversarial code — see module
 * docstring for caveats.
 *
 * @example
 * ```ts
 * const result = runInVmSandbox<number>("1 + x", { globals: { x: 41 } });
 * // { ok: true, value: 42, durationMs: <1, timedOut: false }
 * ```
 */
export function runInVmSandbox<T = unknown>(
  code: string,
  options: VmSandboxOptions = {},
): VmSandboxResult<T> {
  const { timeoutMs = 1000, globals = {}, filename = "sandbox.vm" } = options;
  const startedAt = Date.now();
  // Fresh object — no prototype leakage from caller, no host globals.
  const context: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(globals)) context[k] = v;

  try {
    const value = runInNewContext(code, context, {
      timeout: timeoutMs,
      filename,
      displayErrors: true,
    }) as T;
    return { ok: true, value, durationMs: Date.now() - startedAt, timedOut: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /Script execution timed out/i.test(message);
    return { ok: false, error: message, durationMs: Date.now() - startedAt, timedOut };
  }
}
