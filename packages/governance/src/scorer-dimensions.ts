/**
 * 7-Dimension Governance Scorers
 *
 * Each function scores an agent on one governance dimension (0-100).
 * Separated from scorer.ts to keep files under 300 LOC.
 */

import type { AgentRegistration, DimensionResult, ScoreDimension } from "./types.js";

// ─── Dimension Weights ──────────────────────────────────────────
//
// RATIONALE (see also docs/scoring-rationale.md):
//
// These weights are calibrated around a simple question — "if this
// dimension is weak, how likely is it that the agent causes a harmful
// incident in production?"
//
//   identity       (1.5) — if you can't tell who's calling, every other
//                           control is weakened. Anchors the whole model.
//   permissions    (1.5) — tool / scope over-grant is the #1 cause of
//                           "the agent did the wrong thing" incidents.
//   guardrails     (1.3) — prevent-before-action controls stop most
//                           classes of runtime harm.
//   observability  (1.2) — you can only respond to incidents you can see.
//   auditability   (1.0) — post-hoc forensics; important, but only AFTER
//                           the incident has already occurred.
//   compliance     (1.0) — standards mapping; procedural, downstream of
//                           the above controls.
//   lifecycle      (0.8) — owner / version / description metadata;
//                           contributes to governance maturity but
//                           doesn't itself prevent incidents.
//
// These are opinionated defaults, not a research-validated model. If your
// risk profile differs (e.g. in highly-regulated industries where
// `compliance` is load-bearing), override with a custom weight map.
// Weights are multiplied against per-dimension 0-100 scores and averaged
// into the 0-100 composite — so "identity weighted 1.5" means a 20-point
// gap in identity costs ~1.87x as much as a 20-point gap in lifecycle.
export const DIMENSION_WEIGHTS: Record<ScoreDimension, number> = {
  identity: 1.5,
  permissions: 1.5,
  observability: 1.2,
  guardrails: 1.3,
  auditability: 1.0,
  compliance: 1.0,
  lifecycle: 0.8,
};

// ─── Dimension Scorers ──────────────────────────────────────────

function scoreIdentity(agent: AgentRegistration): DimensionResult {
  const evidence: Record<string, boolean | number | string> = {};
  let score = 0;

  evidence.hasName = !!agent.name;
  if (agent.name) score += 15;
  evidence.hasOwner = !!agent.owner;
  if (agent.owner) score += 20;
  evidence.knownFramework = agent.framework !== "unknown";
  if (agent.framework !== "unknown") score += 15;
  evidence.isVersioned = !!agent.version && agent.version !== "1.0.0";
  if (agent.version && agent.version !== "1.0.0") score += 10;
  evidence.hasDescription = !!agent.description;
  if (agent.description) score += 10;
  evidence.hasAuth = !!agent.hasAuth;
  if (agent.hasAuth) score += 20;
  evidence.channelCount = agent.channels?.length ?? 0;
  if (agent.channels && agent.channels.length > 0) score += 10;

  return { dimension: "identity", score: Math.min(score, 100), weight: DIMENSION_WEIGHTS.identity, evidence };
}

function scorePermissions(agent: AgentRegistration): DimensionResult {
  const evidence: Record<string, boolean | number | string> = {};
  let score = 0;

  evidence.hasPermissions = !!agent.permissions;
  if (agent.permissions) score += 30;
  evidence.toolCount = agent.tools?.length ?? 0;
  if (agent.tools && agent.tools.length > 0) score += 20;
  if (agent.tools) {
    if (agent.tools.length <= 5) score += 20;
    else if (agent.tools.length <= 15) score += 10;
    if (agent.tools.length > 20 && !agent.permissions) score -= 10;
  }
  evidence.hasAuth = !!agent.hasAuth;
  if (agent.hasAuth) score += 20;
  evidence.hasChannels = (agent.channels?.length ?? 0) > 0;
  if (agent.channels && agent.channels.length > 0) score += 10;

  return { dimension: "permissions", score: Math.max(0, Math.min(score, 100)), weight: DIMENSION_WEIGHTS.permissions, evidence };
}

function scoreObservability(agent: AgentRegistration): DimensionResult {
  const evidence: Record<string, boolean | number | string> = {};
  let score = 0;

  evidence.hasObservability = !!agent.hasObservability;
  if (agent.hasObservability) score += 40;
  evidence.hasAuditLog = !!agent.hasAuditLog;
  if (agent.hasAuditLog) score += 30;
  evidence.frameworkTracing = agent.framework === "mastra";
  if (agent.framework === "mastra") score += 20;
  else if (agent.framework !== "unknown" && agent.framework !== "custom") score += 10;
  evidence.hasMetadata = !!agent.metadata;
  if (agent.metadata) score += 10;

  return { dimension: "observability", score: Math.min(score, 100), weight: DIMENSION_WEIGHTS.observability, evidence };
}

function scoreGuardrails(agent: AgentRegistration): DimensionResult {
  const evidence: Record<string, boolean | number | string> = {};
  let score = 0;

  evidence.hasGuardrails = !!agent.hasGuardrails;
  if (agent.hasGuardrails) score += 40;
  evidence.hasAuth = !!agent.hasAuth;
  if (agent.hasAuth) score += 20;
  evidence.nativeGuardrails = agent.framework === "mastra";
  if (agent.framework === "mastra") score += 20;
  evidence.boundedTools = (agent.tools?.length ?? 0) > 0 && (agent.tools?.length ?? 0) <= 15;
  if (evidence.boundedTools) score += 10;
  evidence.hasPermissions = !!agent.permissions;
  if (agent.permissions) score += 10;

  return { dimension: "guardrails", score: Math.min(score, 100), weight: DIMENSION_WEIGHTS.guardrails, evidence };
}

function scoreAuditability(agent: AgentRegistration): DimensionResult {
  const evidence: Record<string, boolean | number | string> = {};
  let score = 0;

  evidence.hasAuditLog = !!agent.hasAuditLog;
  if (agent.hasAuditLog) score += 40;
  evidence.hasObservability = !!agent.hasObservability;
  if (agent.hasObservability) score += 25;
  evidence.hasOwner = !!agent.owner;
  if (agent.owner) score += 15;
  evidence.isVersioned = !!agent.version;
  if (agent.version) score += 10;
  evidence.hasDescription = !!agent.description;
  if (agent.description) score += 10;

  return { dimension: "auditability", score: Math.min(score, 100), weight: DIMENSION_WEIGHTS.auditability, evidence };
}

function scoreCompliance(agent: AgentRegistration): DimensionResult {
  const evidence: Record<string, boolean | number | string> = {};
  let score = 0;

  evidence.hasAuditLog = !!agent.hasAuditLog;
  if (agent.hasAuditLog) score += 25;
  evidence.hasGuardrails = !!agent.hasGuardrails;
  if (agent.hasGuardrails) score += 20;
  evidence.hasAuth = !!agent.hasAuth;
  if (agent.hasAuth) score += 15;
  evidence.hasObservability = !!agent.hasObservability;
  if (agent.hasObservability) score += 15;
  evidence.hasOwner = !!agent.owner;
  if (agent.owner) score += 10;
  evidence.hasPermissions = !!agent.permissions;
  if (agent.permissions) score += 15;

  return { dimension: "compliance", score: Math.min(score, 100), weight: DIMENSION_WEIGHTS.compliance, evidence };
}

function scoreLifecycle(agent: AgentRegistration): DimensionResult {
  const evidence: Record<string, boolean | number | string> = {};
  let score = 0;

  evidence.hasOwner = !!agent.owner;
  if (agent.owner) score += 25;
  evidence.isVersioned = !!agent.version;
  if (agent.version) score += 20;
  evidence.hasDescription = !!agent.description;
  if (agent.description) score += 15;
  evidence.knownFramework = agent.framework !== "unknown";
  if (agent.framework !== "unknown") score += 15;
  evidence.hasChannels = (agent.channels?.length ?? 0) > 0;
  if (agent.channels && agent.channels.length > 0) score += 10;
  evidence.hasMetadata = !!agent.metadata;
  if (agent.metadata) score += 15;

  return { dimension: "lifecycle", score: Math.min(score, 100), weight: DIMENSION_WEIGHTS.lifecycle, evidence };
}

// ─── Scorer Map ─────────────────────────────────────────────────

export const DIMENSION_SCORERS: Record<ScoreDimension, (agent: AgentRegistration) => DimensionResult> = {
  identity: scoreIdentity,
  permissions: scorePermissions,
  observability: scoreObservability,
  guardrails: scoreGuardrails,
  auditability: scoreAuditability,
  compliance: scoreCompliance,
  lifecycle: scoreLifecycle,
};
