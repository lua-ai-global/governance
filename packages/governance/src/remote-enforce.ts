/**
 * Remote Enforcement — proxy enforce() and register() to Lua Governance Cloud.
 *
 * When serverUrl is configured, these functions POST to the remote API
 * instead of evaluating locally. Includes retry with exponential backoff,
 * graceful fallback on failure, and connection health checking.
 */

import type { EnforcementContext, EnforcementDecision, PolicyStage } from "./policy.js";
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
    stage?: PolicyStage,
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
      // The API answered us (even with a 4xx error), so the connection
      // itself is live. Reflect that in status() so callers aren't misled
      // into thinking the API is offline.
      if (err instanceof RemoteEnforcementError && !err.retryable) {
        lastConnected = true;
        throw err;
      }
      // Network/timeout errors after retries — use fallback
      lastConnected = false;
      return fallbackDecision(fallbackMode, err);
    }
  }

  /**
   * Register (or look up) an agent against the cloud API.
   *
   * POSTs to `/api/v1/agents` with the registration payload. The API
   * auto-dedupes by id/name, so calling this on a pre-existing agent
   * is idempotent — it returns the existing record's authoritative
   * score + level. This fixes the previous placeholder behaviour where
   * remoteRegister returned `level: 0` unconditionally, which caused
   * agent_level-conditioned rules to fire incorrectly for higher-level
   * agents on every enforce().
   *
   * If the cloud call fails for any reason (network, auth, 5xx), we
   * still return a synthetic "registered" receipt so the caller isn't
   * blocked on a non-essential register step. The next enforce() will
   * carry authoritative data regardless.
   */
  async function remoteRegister(input: AgentRegistration): Promise<RemoteRegisterResult> {
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          id: input.id,
          name: input.name,
          framework: input.framework,
          owner: input.owner,
          description: input.description,
          tools: input.tools,
          channels: input.channels,
          hasAuth: input.hasAuth,
          hasGuardrails: input.hasGuardrails,
          hasObservability: input.hasObservability,
          hasAuditLog: input.hasAuditLog,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (response.ok) {
        const data = await response.json() as {
          id?: string;
          name?: string;
          compositeScore?: number;
          governanceLevel?: number;
          status?: string;
        };
        const id = data.id ?? input.name;
        const score = typeof data.compositeScore === "number" ? data.compositeScore : 0;
        // Clamp to the valid GovernanceLevel range (0-4). The API is the
        // source of truth here, but we validate defensively.
        const rawLevel = typeof data.governanceLevel === "number" ? data.governanceLevel : 0;
        const level = (rawLevel >= 0 && rawLevel <= 4
          ? Math.round(rawLevel)
          : 0) as 0 | 1 | 2 | 3 | 4;
        const status: "registered" | "assessed" | "approved" | "flagged" | "deprecated" | "quarantined" =
          data.status === "assessed" || data.status === "approved" ||
          data.status === "flagged" || data.status === "deprecated" ||
          data.status === "quarantined"
            ? data.status
            : "registered";
        return {
          id,
          score,
          level,
          status,
          assessment: {
            agentId: id,
            agentName: data.name ?? input.name,
            compositeScore: score,
            level: { level, label: "live", autonomy: "governed", minScore: 0, maxScore: 100 },
            status,
            dimensions: [],
            recommendations: [],
            assessedAt: new Date().toISOString(),
          },
        };
      }
      // 409 / 4xx — fall through to the synthetic receipt. The next
      // enforce() is still authoritative.
    } catch {
      // Network/timeout — same fall-through.
    }
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
