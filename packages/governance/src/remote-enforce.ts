/**
 * Remote Enforcement — proxy enforce() and register() to Lua Governance Cloud.
 *
 * When serverUrl is configured, these functions POST to the remote API
 * instead of evaluating locally. Includes retry with exponential backoff,
 * graceful fallback on failure, and connection health checking.
 */

import type { EnforcementContext, EnforcementDecision } from "./policy.js";
import type { AgentRegistration, GovernanceAssessment } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────

export type FallbackMode = "allow" | "block";

export interface RemoteConfig {
  serverUrl: string;
  apiKey: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Max retry attempts for transient failures (default: 3) */
  maxRetries?: number;
  /** What to do when the API is unreachable after retries (default: "allow") */
  fallbackMode?: FallbackMode;
}

export interface RemoteRegisterResult {
  id: string;
  score: number;
  level: number;
  status: string;
  assessment: GovernanceAssessment;
}

export interface RemoteStatus {
  connected: boolean;
  mode: "remote" | "fallback";
  latencyMs: number;
  plan?: string;
  features?: string[];
  agentQuota?: { used: number; limit: number | "unlimited" };
}

/** Error thrown when remote API returns a non-OK response */
export class RemoteEnforcementError extends Error {
  public readonly retryable: boolean;

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = "RemoteEnforcementError";
    // 5xx and network errors are retryable; 4xx are not
    this.retryable = statusCode >= 500 || statusCode === 0;
  }
}

// ─── Retry Helper ──────────────────────────────────────────────

const RETRY_DELAYS = [100, 500, 2000]; // exponential backoff

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Don't retry non-retryable errors (4xx)
      if (err instanceof RemoteEnforcementError && !err.retryable) throw err;
      // Don't retry after last attempt
      if (attempt >= maxRetries) break;
      // Wait before retry
      const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ─── Fallback Decision ─────────────────────────────────────────

function fallbackDecision(mode: FallbackMode, error: unknown): EnforcementDecision {
  const reason = error instanceof Error ? error.message : "Remote enforcement unavailable";
  return {
    blocked: mode === "block",
    reason: `Governance API unreachable — ${mode === "block" ? "blocking" : "allowing"} by fallback policy. ${reason}`,
    ruleId: null,
    outcome: mode === "block" ? "block" : "allow",
    evaluatedAt: new Date().toISOString(),
    rulesEvaluated: 0,
  };
}

// ─── Remote Enforcer ────────────────────────────────────────────

/**
 * Create a remote enforcer that proxies calls to Lua Governance Cloud.
 *
 * @param config - Remote server URL, API key, and resilience options
 * @returns Object with remote enforce, register, connect, status, and waitForApproval
 */
export function createRemoteEnforcer(config: RemoteConfig) {
  const { serverUrl, apiKey } = config;
  const timeout = config.timeout ?? 30_000;
  const maxRetries = config.maxRetries ?? 3;
  const fallbackMode = config.fallbackMode ?? "allow";
  const baseUrl = serverUrl.replace(/\/$/, "");

  let lastConnected = false;
  let lastLatencyMs = 0;

  async function remoteEnforce(
    ctx: EnforcementContext,
    stage?: "preprocess" | "process" | "postprocess",
  ): Promise<EnforcementDecision> {
    const endpoint = stage
      ? `${baseUrl}/api/v1/enforce/${stage}`
      : `${baseUrl}/api/v1/enforce`;

    try {
      const result = await withRetry(async () => {
        const start = performance.now();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(ctx),
          signal: AbortSignal.timeout(timeout),
        });
        lastLatencyMs = Math.round(performance.now() - start);

        if (!response.ok) {
          const body = await response.text();
          throw new RemoteEnforcementError(
            `Remote enforce failed: ${response.status} ${response.statusText}`,
            response.status,
            body,
          );
        }

        return response.json() as Promise<{
          decision: EnforcementDecision;
          approvalId?: string;
          approval?: EnforcementDecision["approval"];
        } | EnforcementDecision>;
      }, maxRetries);

      lastConnected = true;

      // API returns { decision: {...}, approvalId, approval } — unwrap and merge
      if ("decision" in result && result.decision && typeof result.decision === "object" && "blocked" in result.decision) {
        const decision = result.decision;
        if (result.approvalId) decision.approvalId = result.approvalId;
        if (result.approval) decision.approval = result.approval;
        return decision;
      }
      return result as EnforcementDecision;
    } catch (err) {
      // Non-retryable errors (4xx) should throw immediately
      if (err instanceof RemoteEnforcementError && !err.retryable) throw err;
      // Network/timeout errors after retries — use fallback
      lastConnected = false;
      return fallbackDecision(fallbackMode, err);
    }
  }

  /**
   * In cloud mode, this returns a SYNTHETIC confirmation. There is no
   * dedicated remote register endpoint — the API auto-registers agents
   * on the first `enforce()` call. The returned `score` / `level` are
   * placeholder zeros; authoritative values arrive after first enforce.
   *
   * If you need a registration receipt before any enforcement happens,
   * use local mode (no `serverUrl`) or call the cloud REST API directly.
   */
  async function remoteRegister(input: AgentRegistration): Promise<RemoteRegisterResult> {
    return {
      id: input.name,
      score: 0,
      level: 0,
      status: "registered",
      assessment: {
        agentId: input.name,
        agentName: input.name,
        compositeScore: 0,
        level: { level: 0, label: "pending", autonomy: "none", minScore: 0, maxScore: 0 },
        status: "registered",
        dimensions: [],
        recommendations: [],
        assessedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Test connectivity to the governance API. Returns status without throwing.
   * Call at startup to verify the connection before first enforce().
   */
  async function connect(): Promise<RemoteStatus> {
    try {
      const start = performance.now();
      const res = await fetch(`${baseUrl}/api/v1/connect`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      lastLatencyMs = Math.round(performance.now() - start);
      lastConnected = res.ok;

      if (res.ok) {
        const data = await res.json() as {
          plan?: string;
          features?: string[];
          agentQuota?: { used: number; limit: number | "unlimited" };
        };
        return {
          connected: true, mode: "remote", latencyMs: lastLatencyMs,
          plan: data.plan, features: data.features, agentQuota: data.agentQuota,
        };
      }
    } catch {
      lastConnected = false;
      lastLatencyMs = 0;
    }
    return { connected: lastConnected, mode: lastConnected ? "remote" : "fallback", latencyMs: lastLatencyMs };
  }

  /** Current connection status. */
  function status(): RemoteStatus {
    return { connected: lastConnected, mode: lastConnected ? "remote" : "fallback", latencyMs: lastLatencyMs };
  }

  /**
   * Poll an approval until it resolves. Returns the final status.
   * Useful for agents that want to pause and wait for human approval.
   */
  async function waitForApproval(
    approvalId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<"approved" | "denied" | "expired" | "timeout"> {
    const timeoutMs = opts?.timeoutMs ?? 30 * 60 * 1000; // 30 minutes
    const pollInterval = opts?.pollIntervalMs ?? 5000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/api/v1/approvals/${approvalId}`, {
          headers: { "Authorization": `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json() as { request?: { status?: string } };
          const s = data.request?.status;
          if (s === "approved") return "approved";
          if (s === "denied" || s === "cancelled") return "denied";
          if (s === "expired") return "expired";
        }
      } catch {
        // transient failure — continue polling
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    return "timeout";
  }

  return { enforce: remoteEnforce, register: remoteRegister, connect, status, waitForApproval };
}

/**
 * Validate remote config — throws if serverUrl is set but apiKey is missing,
 * or if serverUrl is not a valid http/https URL.
 */
export function validateRemoteConfig(serverUrl?: string, apiKey?: string): void {
  if (!serverUrl) return;
  if (!apiKey) {
    throw new Error("apiKey is required when serverUrl is configured");
  }
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error(`Invalid serverUrl: "${serverUrl}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid serverUrl protocol "${parsed.protocol}" — only http: and https: are allowed`);
  }
}
