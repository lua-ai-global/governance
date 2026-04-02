/**
 * governance-sdk — Multi-Agent Federation Protocol
 *
 * Cross-boundary governance for multi-agent systems.
 * Enables agents governed by different instances to exchange postures,
 * negotiate shared policies, and link audit trails.
 *
 * @example
 * ```ts
 * import { createFederation } from 'governance-sdk/federation';
 *
 * const federation = createFederation(localGovernance, { minimumRemoteScore: 50 });
 *
 * // Exchange postures before inter-agent communication
 * const localPosture = await federation.createPosture('agent-1');
 * const evaluation = federation.evaluatePosture(remotePosture);
 * if (!evaluation.accepted) throw new Error(evaluation.reason);
 *
 * // Negotiate shared policies
 * const negotiation = federation.negotiatePolicies(remoteRules);
 *
 * // Link audit events across boundaries
 * federation.linkAudit('local-event-123', 'remote-event-456', 'remote-agent-id');
 * ```
 */

import type { GovernanceInstance } from "./index.js";
import type {
  GovernancePosture,
  PostureEvaluation,
  PolicyNegotiationResult,
  FederatedAuditLink,
  FederationConfig,
} from "./federation-types.js";
import type { PolicyRule } from "./policy.js";

export type {
  GovernancePosture,
  PostureEvaluation,
  PolicyNegotiationResult,
  FederatedAuditLink,
  FederationConfig,
} from "./federation-types.js";

// ─── Implementation ─────────────────────────────────────────

export function createFederation(governance: GovernanceInstance, config: FederationConfig = {}) {
  const {
    minimumRemoteScore = 40,
    requiredCompliance = [],
    maxNegotiatedRules = 50,
    requireSignedPosture = false,
  } = config;

  const auditLinks: FederatedAuditLink[] = [];

  return {
    /** Create a governance posture for a local agent to share with remote agents */
    async createPosture(agentId: string): Promise<GovernancePosture> {
      const agent = await governance.storage.getAgent(agentId);
      if (!agent) throw new Error(`Agent ${agentId} not found`);

      const rules = governance.policies.getRules();

      return {
        agentId: agent.id,
        agentName: agent.name,
        compositeScore: agent.compositeScore,
        level: agent.governanceLevel,
        capabilities: agent.tools ?? [],
        complianceFrameworks: detectComplianceFrameworks(rules),
        policyCount: rules.length,
        auditIntegrity: rules.some((r) => r.id.includes("integrity")),
        issuedAt: new Date().toISOString(),
      };
    },

    /** Evaluate a remote agent's posture against local requirements */
    evaluatePosture(remote: GovernancePosture): PostureEvaluation {
      if (requireSignedPosture && !remote.signature) {
        return { accepted: false, reason: "Remote posture is not signed", remoteScore: remote.compositeScore, localMinimumScore: minimumRemoteScore, capabilityOverlap: [] };
      }

      if (remote.compositeScore < minimumRemoteScore) {
        return { accepted: false, reason: `Remote score ${remote.compositeScore} below minimum ${minimumRemoteScore}`, remoteScore: remote.compositeScore, localMinimumScore: minimumRemoteScore, capabilityOverlap: [] };
      }

      if (requiredCompliance.length > 0) {
        const hasRequired = requiredCompliance.some((f) => remote.complianceFrameworks.includes(f));
        if (!hasRequired) {
          return { accepted: false, reason: `Remote agent missing required compliance: ${requiredCompliance.join(", ")}`, remoteScore: remote.compositeScore, localMinimumScore: minimumRemoteScore, capabilityOverlap: [] };
        }
      }

      if (remote.expiresAt && new Date(remote.expiresAt).getTime() < Date.now()) {
        return { accepted: false, reason: "Remote posture has expired", remoteScore: remote.compositeScore, localMinimumScore: minimumRemoteScore, capabilityOverlap: [] };
      }

      const localRules = governance.policies.getRules();
      const localCapabilities = new Set<string>();
      for (const r of localRules) {
        const tools = r.condition.params.tools as string[] | undefined;
        if (tools) tools.forEach((t) => localCapabilities.add(t));
      }
      const capabilityOverlap = remote.capabilities.filter((c) => localCapabilities.has(c));

      return {
        accepted: true,
        reason: `Remote agent accepted (score: ${remote.compositeScore}, level: ${remote.level})`,
        remoteScore: remote.compositeScore,
        localMinimumScore: minimumRemoteScore,
        capabilityOverlap,
      };
    },

    /** Negotiate shared policies between local and remote governance */
    negotiatePolicies(remoteRules: PolicyRule[]): PolicyNegotiationResult {
      const localRules = governance.policies.getRules();
      const localIds = new Set(localRules.map((r) => r.id));
      const remoteIds = new Set(remoteRules.map((r) => r.id));

      const sharedRules: PolicyRule[] = [];
      const conflicts: string[] = [];

      // Find rules present in both with matching conditions
      for (const local of localRules) {
        const remote = remoteRules.find((r) => r.condition.type === local.condition.type);
        if (remote) {
          if (local.outcome === remote.outcome) {
            sharedRules.push({ ...local, id: `federated-${local.id}`, priority: Math.max(local.priority, remote.priority) });
          } else {
            conflicts.push(`Conflict on ${local.condition.type}: local=${local.outcome}, remote=${remote.outcome}`);
            // Default: stricter outcome wins
            const stricter = outcomeStrictness(local.outcome) >= outcomeStrictness(remote.outcome) ? local : remote;
            sharedRules.push({ ...stricter, id: `federated-${stricter.id}` });
          }
        }
      }

      if (sharedRules.length > maxNegotiatedRules) {
        sharedRules.length = maxNegotiatedRules;
      }

      const localOnly = localRules.filter((r) => !remoteRules.some((rr) => rr.condition.type === r.condition.type));
      const remoteOnly = remoteRules.filter((r) => !localRules.some((lr) => lr.condition.type === r.condition.type));

      return {
        agreed: conflicts.length === 0,
        sharedRules,
        localOnlyRules: localOnly,
        remoteOnlyRules: remoteOnly,
        conflicts,
      };
    },

    /** Link a local audit event to a remote audit event */
    linkAudit(localEventId: string, remoteEventId: string, remoteAgentId: string, linkType: FederatedAuditLink["linkType"] = "send"): FederatedAuditLink {
      const link: FederatedAuditLink = {
        localEventId,
        remoteEventId,
        remoteAgentId,
        linkType,
        linkedAt: new Date().toISOString(),
      };
      auditLinks.push(link);
      return link;
    },

    /** Get all federated audit links */
    getAuditLinks(remoteAgentId?: string): FederatedAuditLink[] {
      if (remoteAgentId) return auditLinks.filter((l) => l.remoteAgentId === remoteAgentId);
      return [...auditLinks];
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────

function outcomeStrictness(outcome: string): number {
  switch (outcome) {
    case "block": return 3;
    case "require_approval": return 2;
    case "warn": return 1;
    case "allow": return 0;
    default: return 0;
  }
}

function detectComplianceFrameworks(rules: PolicyRule[]): string[] {
  const frameworks: string[] = [];
  // Heuristic: if policy rules exist, governance is active
  if (rules.length > 0) frameworks.push("governance-active");
  if (rules.some((r) => r.condition.type === "injection_guard")) frameworks.push("injection-detection");
  if (rules.some((r) => r.outcome === "require_approval")) frameworks.push("human-oversight");
  return frameworks;
}
