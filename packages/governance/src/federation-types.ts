/**
 * @lua-ai-global/governance — Multi-Agent Federation Types
 *
 * Types for cross-boundary governance between agents governed
 * by different governance instances.
 */

import type { GovernanceAssessment } from "./types.js";
import type { PolicyRule } from "./policy.js";

/** Governance posture exchanged between federated agents */
export interface GovernancePosture {
  agentId: string;
  agentName: string;
  publicKeyHex?: string;
  compositeScore: number;
  level: number;
  capabilities: string[];
  complianceFrameworks: string[];
  policyCount: number;
  auditIntegrity: boolean;
  issuedAt: string;
  expiresAt?: string;
  signature?: string;
}

/** Result of evaluating a remote agent's posture */
export interface PostureEvaluation {
  accepted: boolean;
  reason: string;
  remoteScore: number;
  localMinimumScore: number;
  capabilityOverlap: string[];
}

/** Result of negotiating shared policies between two governance instances */
export interface PolicyNegotiationResult {
  agreed: boolean;
  sharedRules: PolicyRule[];
  localOnlyRules: PolicyRule[];
  remoteOnlyRules: PolicyRule[];
  conflicts: string[];
}

/** Linked audit event connecting two governance instances */
export interface FederatedAuditLink {
  localEventId: string;
  remoteEventId: string;
  remoteAgentId: string;
  linkType: "send" | "receive" | "delegate" | "negotiate";
  linkedAt: string;
}

/** Configuration for federation */
export interface FederationConfig {
  /** Minimum composite score to accept a remote agent (default: 40) */
  minimumRemoteScore?: number;
  /** Required compliance frameworks (remote must have at least one) */
  requiredCompliance?: string[];
  /** Maximum negotiated rule count (default: 50) */
  maxNegotiatedRules?: number;
  /** Whether to require signed postures (default: false) */
  requireSignedPosture?: boolean;
}
