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

    return response.json() as Promise<EnforcementDecision>;
  }

  async function remoteRegister(input: AgentRegistration): Promise<RemoteRegisterResult> {
    const response = await fetch(`${baseUrl}/api/v1/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RemoteEnforcementError(
        `Remote register failed: ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    return response.json() as Promise<RemoteRegisterResult>;
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
