/**
 * Remote Enforcement — proxy enforce() and register() to Lua Governance Cloud.
 *
 * When serverUrl is configured, these functions POST to the remote API
 * instead of evaluating locally. All other methods (audit, score, policies)
 * continue to work locally.
 */

import type { EnforcementContext, EnforcementDecision } from "./policy.js";
import type { AgentRegistration, GovernanceAssessment } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────

export interface RemoteConfig {
  serverUrl: string;
  apiKey: string;
}

export interface RemoteRegisterResult {
  id: string;
  score: number;
  level: number;
  status: string;
  assessment: GovernanceAssessment;
}

/** Error thrown when remote API returns a non-OK response */
export class RemoteEnforcementError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = "RemoteEnforcementError";
  }
}

// ─── Remote Enforcer ────────────────────────────────────────────

/**
 * Create a remote enforcer that proxies calls to Lua Governance Cloud.
 *
 * @param config - Remote server URL and API key
 * @returns Object with remote enforce and register functions
 */
export function createRemoteEnforcer(config: RemoteConfig) {
  const { serverUrl, apiKey } = config;
  const baseUrl = serverUrl.replace(/\/$/, "");

  async function remoteEnforce(ctx: EnforcementContext): Promise<EnforcementDecision> {
    const response = await fetch(`${baseUrl}/api/v1/enforce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(ctx),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RemoteEnforcementError(
        `Remote enforce failed: ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    const body = await response.json() as { decision: EnforcementDecision } | EnforcementDecision;
    // API returns { decision: {...}, duration, operationId } — unwrap if nested
    return "decision" in body && body.decision && typeof body.decision === "object" && "blocked" in body.decision
      ? body.decision
      : body as EnforcementDecision;
  }

  /**
   * Remote register is a local-only operation — the API auto-registers
   * agents on first enforce call, so no dedicated endpoint exists.
   * Returns a synthetic result so callers can use agent.id in enforce().
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

  return { enforce: remoteEnforce, register: remoteRegister };
}

/**
 * Validate remote config — throws if serverUrl is set but apiKey is missing.
 */
export function validateRemoteConfig(serverUrl?: string, apiKey?: string): void {
  if (serverUrl && !apiKey) {
    throw new Error("apiKey is required when serverUrl is configured");
  }
}
