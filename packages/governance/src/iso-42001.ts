/**
 * @lua-ai-global/governance — ISO/IEC 42001 Compliance Assessment
 *
 * Assesses governance configuration against ISO 42001 AI Management System clauses.
 * Clause definitions are in iso-42001-articles.ts.
 */

import type { StoredAgent, GovernanceInstance } from "./index.js";
import type { ComplianceStatus, RequirementAssessment, ArticleAssessment } from "./compliance-articles.js";
import { ISO_42001_CLAUSES, type Iso42001Report } from "./iso-42001-articles.js";

export type { IsoClause, IsoRequirement, Iso42001Report } from "./iso-42001-articles.js";
export { getIsoClauses } from "./iso-42001-articles.js";

// ─── Assessment Config ───────────────────────────────────────

export interface Iso42001AssessmentConfig {
  governance: GovernanceInstance;
  agents: StoredAgent[];
  auditIntegrity?: boolean;
  policiesTested?: boolean;
}

// ─── Assessment ─────────────────────────────────────────────

export async function assessIso42001(
  config: Iso42001AssessmentConfig,
): Promise<Iso42001Report> {
  const clauseAssessments: ArticleAssessment[] = [];

  for (const clause of ISO_42001_CLAUSES) {
    const reqAssessments: RequirementAssessment[] = [];
    for (const req of clause.requirements) {
      reqAssessments.push(await assessRequirement(req.id, config));
    }

    const compliantCount = reqAssessments.filter((r) => r.status === "compliant").length;
    const partialCount = reqAssessments.filter((r) => r.status === "partial").length;
    const total = reqAssessments.length;
    const score = Math.round(((compliantCount + partialCount * 0.5) / total) * 100);
    const coverage: ComplianceStatus =
      score >= 80 ? "compliant" : score >= 40 ? "partial" : "non-compliant";

    clauseAssessments.push({
      article: clause.id,
      title: clause.title,
      coverage,
      score,
      requirements: reqAssessments,
      deadline: "",
      maxFine: "",
    });
  }

  const overallScore = Math.round(
    clauseAssessments.reduce((sum, a) => sum + a.score, 0) / clauseAssessments.length,
  );
  const status: ComplianceStatus =
    overallScore >= 80 ? "compliant" : overallScore >= 40 ? "partial" : "non-compliant";

  const criticalGaps = clauseAssessments.flatMap((a) =>
    a.requirements
      .filter((r) => r.status === "non-compliant")
      .map((r) => `${a.title} (Clause ${a.article}): ${r.evidence}`),
  );

  const recommendations = clauseAssessments
    .flatMap((a) => a.requirements.filter((r) => r.remediation).map((r) => r.remediation!))
    .filter((v, i, arr) => arr.indexOf(v) === i);

  return {
    overallScore,
    status,
    clauses: clauseAssessments,
    agentsAssessed: config.agents.length,
    criticalGaps,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Requirement Assessors ───────────────────────────────────

async function assessRequirement(
  id: string,
  config: Iso42001AssessmentConfig,
): Promise<RequirementAssessment> {
  const { governance, agents } = config;
  const rules = governance.policies.getRules();

  switch (id) {
    // Clause 4: Context
    case "iso-4.1": {
      if (agents.length === 0) return fail(id, "No agents registered", "Register agents with owner and description");
      const documented = agents.filter((a) => a.owner && a.description);
      if (documented.length === agents.length) return ok(id, `${agents.length} agent(s) documented with context`);
      return partial(id, `${documented.length}/${agents.length} agents documented`);
    }
    case "iso-4.3": {
      if (rules.length > 0 && agents.length > 0) return ok(id, "AIMS scope defined with policies and agents");
      if (rules.length > 0) return partial(id, "Policies configured but no agents registered");
      return fail(id, "No governance scope defined", "Configure policies and register agents");
    }

    // Clause 5: Leadership
    case "iso-5.2": {
      const namedRules = rules.filter((r) => r.name && r.reason);
      if (namedRules.length === rules.length && rules.length > 0)
        return ok(id, `${rules.length} documented policy rule(s)`);
      if (rules.length > 0) return partial(id, `${namedRules.length}/${rules.length} rules documented`);
      return fail(id, "No AI policy established", "Add policy rules with names and reasons");
    }
    case "iso-5.3": {
      if (agents.length === 0) return fail(id, "No agents registered", "Register agents with owner field");
      const withOwner = agents.filter((a) => a.owner);
      if (withOwner.length === agents.length) return ok(id, `${agents.length} agent(s) have designated owners`);
      return partial(id, `${withOwner.length}/${agents.length} agents have owners`);
    }

    // Clause 6: Planning
    case "iso-6.1": {
      if (agents.length === 0) return fail(id, "No agents scored", "Register agents for risk assessment");
      const scored = agents.filter((a) => a.compositeScore > 0);
      if (scored.length === agents.length) return ok(id, `${agents.length} agent(s) risk-assessed across 7 dimensions`);
      return partial(id, `${scored.length}/${agents.length} agents scored`);
    }
    case "iso-6.2": {
      if (agents.some((a) => a.governanceLevel >= 0)) return ok(id, "Governance levels assigned as AI objectives");
      return fail(id, "No governance levels assigned", "Score agents to assign governance levels");
    }

    // Clause 8: Operation
    case "iso-8.2": {
      const count = await governance.audit.count();
      if (count > 0 && agents.some((a) => a.compositeScore > 0))
        return ok(id, "Risk assessment active with audit trail and scoring");
      if (agents.some((a) => a.compositeScore > 0)) return partial(id, "Agents scored but no audit events");
      return fail(id, "No risk assessment active", "Enable audit logging and score agents");
    }
    case "iso-8.3": {
      const outcomes = new Set(rules.map((r) => r.outcome));
      if (outcomes.size >= 2) return ok(id, `Risk treatment with ${outcomes.size} outcome levels: ${[...outcomes].join(", ")}`);
      if (rules.length > 0) return partial(id, "Single outcome level", "Use graduated outcomes (block, warn, require_approval)");
      return fail(id, "No risk treatment plan", "Configure policy rules with multiple outcome levels");
    }
    case "iso-8.4":
      return config.policiesTested
        ? ok(id, "Impact assessment performed via dry-run simulation")
        : partial(id, "Impact assessment not confirmed", "Test policies with fleetDryRun()");

    // Clause 9: Performance Evaluation
    case "iso-9.1": {
      const count = await governance.audit.count();
      if (count > 0) return ok(id, `${count} audit event(s) available for performance evaluation`);
      return fail(id, "No monitoring data", "Enable audit logging");
    }
    case "iso-9.2":
      return config.auditIntegrity
        ? ok(id, "Tamper-evident audit trail enables verifiable internal audits")
        : partial(id, "Audit integrity not enabled", "Enable createIntegrityAudit() for tamper-evident logging");

    // Clause 10: Improvement
    case "iso-10.1":
      return ok(id, "Kill switch available at priority 999 for corrective action");
    case "iso-10.2": {
      if (agents.some((a) => a.compositeScore > 0)) return ok(id, "Behavioral scoring enables continual improvement tracking");
      return partial(id, "No behavioral tracking", "Score agents to enable drift detection");
    }

    default:
      return { requirementId: id, status: "not-applicable", evidence: "Unknown requirement" };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function ok(id: string, evidence: string): RequirementAssessment {
  return { requirementId: id, status: "compliant", evidence };
}
function partial(id: string, evidence: string, remediation?: string): RequirementAssessment {
  return { requirementId: id, status: "partial", evidence, remediation };
}
function fail(id: string, evidence: string, remediation?: string): RequirementAssessment {
  return { requirementId: id, status: "non-compliant", evidence, remediation };
}
