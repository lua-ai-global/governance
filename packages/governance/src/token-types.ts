/**
 * Shared token type definitions for Propolis → Honeycomb JWT exchange.
 *
 * Zero dependencies. These types define the JWT payload structure.
 *
 * DESIGN PRINCIPLE: The JWT carries identity, trust level, and scope.
 * It does NOT carry tool permissions — those are enforced by governance
 * policies via the policy engine. The JWT tells Honeycomb WHO the agent
 * is and WHAT DATA it can see. Governance tells the agent WHAT ACTIONS
 * it can take.
 *
 * @example
 * ```ts
 * import type { HoneycombAgentToken, TokenRequest } from 'governance-sdk/token-types';
 * ```
 */

// ─── JWT Payload ───────────────────────────────────────────────

/** RS256 JWT payload issued by Propolis for Honeycomb authentication. */
export interface HoneycombAgentToken {
  // RFC 7519 standard claims
  /** Issuer — always "propolis" */
  iss: "propolis";
  /** Audience — always "honeycomb" */
  aud: "honeycomb";
  /** Subject — agentId */
  sub: string;
  /** Issued-at (unix seconds) */
  iat: number;
  /** Expiry (unix seconds) */
  exp: number;
  /** Unique token ID (UUID) — for revocation and audit correlation */
  jti: string;

  // Agent identity
  agentName: string;
  orgId: string;

  // Governance trust level
  /** Governance level (0-4) from composite score */
  governanceLevel: number;
  /** Composite governance score (0-100) */
  compositeScore: number;

  // Data access scope (from agent configuration)
  /** Allowed Honeycomb namespaces */
  namespaces: string[];
  /** Allowed access level values */
  accessLevels: ("public" | "namespace" | "restricted")[];

  // Resource limits (governance-level-driven)
  /** Maximum extraction tier (0=none, 1=slim, 2=full) */
  maxExtractionTier: 0 | 1 | 2;
  /** Maximum concurrent namespaces */
  maxNamespaces: number;

  // Tool access (pre-computed from governance policies at token issuance)
  /** Honeycomb tools this agent is allowed to call */
  allowedTools: string[];

  // Optional capability flags (from agent metadata)
  /** Search across all namespaces */
  allowCrossNamespace?: boolean;
  /** Restrict entity recall by type (undefined = all types) */
  allowedEntityTypes?: string[];
}

// ─── Token Exchange ────────────────────────────────────────────

/** Request body for POST /api/v1/token */
export interface TokenRequest {
  agentId: string;
  agentName: string;
  requestedNamespaces?: string[];
}

/** Response body from POST /api/v1/token */
export interface TokenResponse {
  token: string;
  /** Expiry as unix seconds */
  expiresAt: number;
}

// ─── Resource Limits ───────────────────────────────────────────

/** Resource allocation limits by governance level. */
export interface ResourceLimits {
  maxNamespaces: number;
  maxExtractionTier: 0 | 1 | 2;
}

/**
 * Maps governance level → resource limits.
 *
 * These control COMPUTE COST (extraction depth, data breadth).
 * Authorization (which tools, which actions) is handled by
 * the governance policy engine — NOT by this table.
 */
export const RESOURCE_LIMITS_BY_LEVEL: Record<number, ResourceLimits> = {
  0: { maxNamespaces: 1,        maxExtractionTier: 0 },
  1: { maxNamespaces: 3,        maxExtractionTier: 1 },
  2: { maxNamespaces: 10,       maxExtractionTier: 1 },
  3: { maxNamespaces: 50,       maxExtractionTier: 2 },
  4: { maxNamespaces: Infinity, maxExtractionTier: 2 },
};
