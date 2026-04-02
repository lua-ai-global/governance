/**
 * Governance Score Calculator
 *
 * Takes agent metadata and produces a 0-100 composite score across
 * 7 dimensions, mapped to governance levels (0-4) aligned with
 * CSA ATF progressive autonomy.
 *
 * Dimension scorers are in scorer-dimensions.ts.
 */

import type {
  AgentRegistration,
  DimensionResult,
  GovernanceAssessment,
  GovernanceLevel,
  AgentStatus,
} from "./types.js";
import { DIMENSION_SCORERS } from "./scorer-dimensions.js";

// ─── Governance Levels ──────────────────────────────────────────

const GOVERNANCE_LEVELS: GovernanceLevel[] = [
  { level: 0, label: "Unregistered", autonomy: "No autonomous operation", minScore: 0, maxScore: 20 },
  { level: 1, label: "Basic", autonomy: "Human-in-loop required", minScore: 21, maxScore: 40 },
  { level: 2, label: "Managed", autonomy: "Limited autonomous actions", minScore: 41, maxScore: 60 },
  { level: 3, label: "Governed", autonomy: "Full autonomous within policy", minScore: 61, maxScore: 80 },
  { level: 4, label: "Certified", autonomy: "Cross-team, regulatory-ready", minScore: 81, maxScore: 100 },
];

export function getGovernanceLevel(score: number): GovernanceLevel {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return GOVERNANCE_LEVELS.find((l) => clamped >= l.minScore && clamped <= l.maxScore)
    ?? GOVERNANCE_LEVELS[0];
}

// ─── Composite Score ────────────────────────────────────────────

export function computeCompositeScore(dimensions: DimensionResult[]): number {
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const weightedSum = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0);
  return Math.round(weightedSum / totalWeight);
}

function deriveStatus(score: number): AgentStatus {
  if (score >= 60) return "approved";
  if (score > 0) return "flagged";
  return "registered";
}

function generateRecommendations(dimensions: DimensionResult[]): string[] {
  const recs: string[] = [];

  for (const d of dimensions) {
    if (d.score < 40) {
      switch (d.dimension) {
        case "identity":
          recs.push("Configure agent authentication and declare ownership");
          break;
        case "permissions":
          recs.push("Define explicit permission boundaries and tool access lists");
          break;
        case "observability":
          recs.push("Enable tracing and audit logging for agent actions");
          break;
        case "guardrails":
          recs.push("Add input/output guardrails to prevent unsafe behavior");
          break;
        case "auditability":
          recs.push("Enable audit logging for compliance evidence collection");
          break;
        case "compliance":
          recs.push("Review EU AI Act requirements and configure compliance controls");
          break;
        case "lifecycle":
          recs.push("Document agent purpose, assign owner, and establish version control");
          break;
      }
    }
  }

  if (recs.length === 0) {
    recs.push("Agent meets all governance thresholds. Consider Level 4 certification.");
  }

  return recs;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Assess a single agent's governance readiness.
 */
export function assessAgent(
  agentId: string,
  agent: AgentRegistration,
): GovernanceAssessment {
  const dimensions = Object.values(DIMENSION_SCORERS).map((scorer) => scorer(agent));
  const compositeScore = computeCompositeScore(dimensions);
  const level = getGovernanceLevel(compositeScore);
  const status = deriveStatus(compositeScore);
  const recommendations = generateRecommendations(dimensions);

  return {
    agentId,
    agentName: agent.name,
    compositeScore,
    level,
    dimensions,
    status,
    assessedAt: new Date().toISOString(),
    recommendations,
  };
}

/**
 * Assess an entire fleet and produce a summary.
 */
export function assessFleet(
  agents: { id: string; registration: AgentRegistration }[],
): { assessments: GovernanceAssessment[]; summary: import("./types").FleetSummary } {
  const assessments = agents.map((a) => assessAgent(a.id, a.registration));

  const byStatus: Record<AgentStatus, number> = {
    registered: 0, assessed: 0, approved: 0, flagged: 0, deprecated: 0, quarantined: 0,
  };
  const byFramework: Record<string, number> = {};
  const byLevel: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };

  for (const a of assessments) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    const fw = agents.find((ag) => ag.id === a.agentId)?.registration.framework ?? "unknown";
    byFramework[fw] = (byFramework[fw] || 0) + 1;
    byLevel[a.level.level] = (byLevel[a.level.level] || 0) + 1;
  }

  const scores = assessments.map((a) => a.compositeScore);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  const sorted = [...assessments].sort((a, b) => b.compositeScore - a.compositeScore);

  const fleetRecommendations: string[] = [];
  if (byStatus.flagged > 0) {
    fleetRecommendations.push(`${byStatus.flagged} agent(s) below governance threshold — review immediately`);
  }
  if (byLevel[0] > 0) {
    fleetRecommendations.push(`${byLevel[0]} agent(s) at Level 0 (Unregistered) — complete registration`);
  }
  if (avgScore < 60) {
    fleetRecommendations.push("Fleet average below 60 — prioritize governance improvements before scaling");
  }

  return {
    assessments,
    summary: {
      totalAgents: agents.length,
      averageScore: avgScore,
      fleetLevel: getGovernanceLevel(avgScore),
      byStatus,
      byFramework: byFramework as Record<import("./types").AgentFramework, number>,
      byLevel,
      highestScoring: sorted[0] ? { name: sorted[0].agentName, score: sorted[0].compositeScore } : null,
      lowestScoring: sorted.length > 0 ? { name: sorted[sorted.length - 1].agentName, score: sorted[sorted.length - 1].compositeScore } : null,
      recommendations: fleetRecommendations,
    },
  };
}
