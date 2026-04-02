/**
 * @lua-ai-global/governance — Agent Identity Primitives
 *
 * Cryptographic agent identity using HMAC-SHA256 via Web Crypto API.
 * Zero dependencies. Produces verifiable identity tokens and fingerprints.
 *
 * @example
 * ```ts
 * import { createAgentIdentity } from '@lua-ai-global/governance/agent-identity';
 *
 * const identity = createAgentIdentity('my-signing-key');
 * const token = await identity.issueToken({ id: 'agent-1', name: 'sales-bot', owner: 'team-a' });
 * const valid = await identity.verifyToken(token, { id: 'agent-1', name: 'sales-bot', owner: 'team-a' });
 * const fingerprint = await identity.getFingerprint({ id: 'agent-1', name: 'sales-bot' });
 * ```
 */

import { hmacSha256, deepSortKeys } from "./audit-integrity.js";

// ─── Types ───────────────────────────────────────────────────

/** Minimal agent fields used for identity derivation */
export interface AgentIdentityInput {
  id: string;
  name: string;
  owner?: string;
  version?: string;
  framework?: string;
}

/** Issued identity token with metadata */
export interface AgentIdentityToken {
  /** HMAC-SHA256 hash of canonical agent identity */
  signature: string;
  /** Agent ID this token was issued for */
  agentId: string;
  /** ISO timestamp of token issuance */
  issuedAt: string;
  /** ISO timestamp of token expiry (if configured) */
  expiresAt?: string;
  /** Short fingerprint (first 16 hex chars of signature) */
  fingerprint: string;
}

/** Verification result */
export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

/** Configuration for agent identity */
export interface AgentIdentityConfig {
  /** Token expiry duration in milliseconds (default: no expiry) */
  tokenTtlMs?: number;
}

// ─── Implementation ─────────────────────────────────────────

export function createAgentIdentity(signingKey: string, config: AgentIdentityConfig = {}) {
  if (!signingKey) throw new Error("Signing key is required for agent identity");

  return {
    /**
     * Issue a verifiable identity token for an agent.
     * The token includes an HMAC signature derived from the agent's core identity fields.
     */
    async issueToken(agent: AgentIdentityInput): Promise<AgentIdentityToken> {
      const canonical = canonicalizeAgent(agent);
      const issuedAt = new Date().toISOString();
      const data = `${canonical}|${issuedAt}`;
      const signature = await hmacSha256(signingKey, data);

      const token: AgentIdentityToken = {
        signature,
        agentId: agent.id,
        issuedAt,
        fingerprint: signature.slice(0, 16),
      };

      if (config.tokenTtlMs) {
        token.expiresAt = new Date(Date.now() + config.tokenTtlMs).toISOString();
      }

      return token;
    },

    /**
     * Verify an identity token against an agent's current identity.
     * Recomputes the HMAC and compares against the token signature.
     */
    async verifyToken(token: AgentIdentityToken, agent: AgentIdentityInput): Promise<VerificationResult> {
      if (token.agentId !== agent.id) {
        return { valid: false, reason: "Token agent ID does not match" };
      }

      if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
        return { valid: false, reason: "Token has expired" };
      }

      const canonical = canonicalizeAgent(agent);
      const data = `${canonical}|${token.issuedAt}`;
      const expectedSignature = await hmacSha256(signingKey, data);

      if (expectedSignature !== token.signature) {
        return { valid: false, reason: "Signature mismatch — agent identity may have been tampered with" };
      }

      return { valid: true };
    },

    /**
     * Get a deterministic fingerprint for an agent (first 16 hex chars of identity hash).
     * Useful for human-readable agent identification in logs and dashboards.
     */
    async getFingerprint(agent: AgentIdentityInput): Promise<string> {
      const canonical = canonicalizeAgent(agent);
      const hash = await hmacSha256(signingKey, canonical);
      return hash.slice(0, 16);
    },
  };
}

// ─── Utilities ──────────────────────────────────────────────

/** Canonical serialization of agent identity fields (deterministic, sorted) */
function canonicalizeAgent(agent: AgentIdentityInput): string {
  const identity = deepSortKeys({
    id: agent.id,
    name: agent.name,
    owner: agent.owner ?? "",
    version: agent.version ?? "",
    framework: agent.framework ?? "",
  });
  return JSON.stringify(identity);
}
