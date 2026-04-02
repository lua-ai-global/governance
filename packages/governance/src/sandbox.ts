/**
 * governance-sdk — Policy-Level Execution Sandboxing
 *
 * Sandbox levels implemented as composable policy conditions.
 * No OS-level isolation — governance-enforced boundaries.
 *
 * @example
 * ```ts
 * import { createSandbox, SANDBOX_LEVELS } from 'governance-sdk/sandbox';
 *
 * const sandbox = createSandbox({ level: 2, quotas: { maxToolCalls: 50, maxTokens: 100_000 } });
 * governance.addRule(sandbox.levelRule);
 * governance.addRule(sandbox.quotaRule);
 *
 * // Check quota during enforcement
 * sandbox.recordToolCall();
 * sandbox.recordTokens(500);
 * if (sandbox.quotaExceeded()) { ... }
 * ```
 */

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

// ─── Sandbox Levels ─────────────────────────────────────────

export const SANDBOX_LEVELS: SandboxLevel[] = [
  {
    level: 0,
    label: "Unrestricted",
    description: "Full access — no sandbox restrictions. Use only for trusted, high-governance agents.",
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
    label: "Full Sandboxed",
    description: "All local operations — external requests and payments require escalation.",
    allowedActions: ["tool_call", "message_send", "data_access", "file_write", "database_mutation", "custom"],
  },
];

// ─── Implementation ─────────────────────────────────────────

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

  /** Policy rule that enforces sandbox level action restrictions */
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

  /** Policy rule that enforces session quotas */
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
    /** Get current sandbox state */
    getState: (): Readonly<SandboxState> => ({ ...state }),
    /** Record a tool call (increments counter) */
    recordToolCall: () => { state.toolCalls++; },
    /** Record token usage */
    recordTokens: (count: number) => { state.tokensUsed += count; },
    /** Record cost */
    recordCost: (usd: number) => { state.costUsd += usd; },
    /** Check if any quota is exceeded */
    quotaExceeded,
    /** Reset session state */
    reset: () => { state.toolCalls = 0; state.tokensUsed = 0; state.costUsd = 0; state.startedAt = Date.now(); },
    /** Get the sandbox level definition */
    getLevel: (): SandboxLevel => sandboxLevel,
    /** Get all sandbox level definitions */
    getAllLevels: (): SandboxLevel[] => [...SANDBOX_LEVELS],
  };
}
