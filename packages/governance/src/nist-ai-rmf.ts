/**
 * governance-sdk — NIST AI Risk Management Framework Assessment
 *
 * Assesses governance configuration against NIST AI RMF 1.0 functions.
 * Function definitions are in nist-ai-rmf-articles.ts.
 *
 * Reference: https://www.nist.gov/artificial-intelligence/ai-risk-management-framework
 */

import type { StoredAgent, GovernanceInstance } from "./index.js";
import type { ComplianceStatus, RequirementAssessment, ArticleAssessment } from "./compliance-articles.js";
import { NIST_AI_RMF_FUNCTIONS, type NistAiRmfReport } from "./nist-ai-rmf-articles.js";

export type { NistFunction, NistRequirement, NistAiRmfReport } from "./nist-ai-rmf-articles.js";
export { getNistFunctions } from "./nist-ai-rmf-articles.js";

// ─── Assessment Config ───────────────────────────────────────

export interface NistAssessmentConfig {
  governance: GovernanceInstance;
  agents: StoredAgent[];
  auditIntegrity?: boolean;
  policiesTested?: boolean;
}

// ─── Assessment ─────────────────────────────────────────────

export async function assessNistAiRmf(
  config: NistAssessmentConfig,
): Promise<NistAiRmfReport> {
  const functionAssessments: ArticleAssessment[] = [];

  for (const fn of NIST_AI_RMF_FUNCTIONS) {
    const reqAssessments: RequirementAssessment[] = [];
    for (const req of fn.requirements) {
      reqAssessments.push(await assessRequirement(req.id, config));
    }

    const compliantCount = reqAssessments.filter((r) => r.status === "compliant").length;
    const partialCount = reqAssessments.filter((r) => r.status === "partial").length;
    const total = reqAssessments.length;
    const score = Math.round(((compliantCount + partialCount * 0.5) / total) * 100);
    const coverage: ComplianceStatus =
      score >= 80 ? "compliant" : score >= 40 ? "partial" : "non-compliant";

    functionAssessments.push({
      article: fn.id,
      title: fn.title,
      coverage,
      score,
      requirements: reqAssessments,
      deadline: "",
      maxFine: "",
    });
  }

  const overallScore = Math.round(
    functionAssessments.reduce((sum, a) => sum + a.score, 0) / functionAssessments.length,
  );
  const status: ComplianceStatus =
    overallScore >= 80 ? "compliant" : overallScore >= 40 ? "partial" : "non-compliant";

  const criticalGaps = functionAssessments.flatMap((a) =>
    a.requirements
      .filter((r) => r.status === "non-compliant")
      .map((r) => `${a.title} (${a.article}): ${r.evidence}`),
  );

  const recommendations = functionAssessments
    .flatMap((a) => a.requirements.filter((r) => r.remediation).map((r) => r.remediation!))
    .filter((v, i, arr) => arr.indexOf(v) === i);

  return {
    overallScore,
    status,
    functions: functionAssessments,
    agentsAssessed: config.agents.length,
    criticalGaps,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Requirement Assessors ───────────────────────────────────

async function assessRequirement(
  id: string,
  config: NistAssessmentConfig,
): Promise<RequirementAssessment> {
  const { governance, agents } = config;
  const rules = governance.policies.getRules();

  switch (id) {
    // GOVERN
    case "govern-1.1": {
      if (rules.length > 0 && agents.length > 0) return ok(id, "Governance framework active with policies and registered agents");
      if (rules.length > 0) return partial(id, "Policies configured but no agents registered");
      return fail(id, "No governance framework configured", "Create governance instance with policy rules and register agents");
    }
    case "govern-1.2": {
      const namedRules = rules.filter((r) => r.name && r.reason);
      if (namedRules.length === rules.length && rules.length > 0)
        return ok(id, `${rules.length} documented policy rule(s) with names and reasons`);
      if (rules.length > 0) return partial(id, `${namedRules.length}/${rules.length} rules have names and reasons`);
      return fail(id, "No policy rules configured", "Add policy rules with descriptive names and reasons");
    }
    case "govern-4.1": {
      const hasStorage = true; // governance instance always has storage
      const hasPolicies = rules.length > 0;
      const hasAudit = (await governance.audit.count()) > 0;
      if (hasPolicies && hasAudit) return ok(id, "Governance operational: policies, audit, and storage configured");
      if (hasPolicies) return partial(id, "Policies configured but no audit events yet");
      return fail(id, "Governance not operational", "Configure policy rules and enable audit logging");
    }

    // MAP
    case "map-1.1": {
      if (agents.length === 0) return fail(id, "No agents registered", "Register agents with description and owner metadata");
      const documented = agents.filter((a) => a.description && a.owner);
      if (documented.length === agents.length) return ok(id, `${agents.length} agent(s) have documented purpose and ownership`);
      return partial(id, `${documented.length}/${agents.length} agents documented`, "Add description and owner to all agent registrations");
    }
    case "map-2.1": {
      if (agents.length === 0) return fail(id, "No agents registered", "Register agents to enable risk categorization");
      const scored = agents.filter((a) => a.compositeScore > 0);
      if (scored.length === agents.length) return ok(id, `${agents.length} agent(s) categorized across 7 dimensions with governance levels`);
      return partial(id, `${scored.length}/${agents.length} agents scored`, "Score all agents via gov.register() or gov.score()");
    }
    case "map-3.1": {
      if (agents.length === 0) return fail(id, "No agents registered");
      const withTools = agents.filter((a) => a.tools && a.tools.length > 0);
      if (withTools.length === agents.length) return ok(id, `${agents.length} agent(s) have documented capabilities`);
      return partial(id, `${withTools.length}/${agents.length} agents have tools documented`);
    }

    // MEASURE
    case "measure-1.1": {
      if (agents.length === 0) return fail(id, "No agents scored", "Register agents to enable risk measurement");
      const scored = agents.filter((a) => a.compositeScore > 0);
      if (scored.length === agents.length) return ok(id, "7-dimension scoring active across all agents");
      return partial(id, `${scored.length}/${agents.length} agents scored`);
    }
    case "measure-2.1": {
      const hasInjection = rules.some((r) => r.condition.type === "injection_guard");
      const blocked = await governance.audit.count({ outcome: "block" });
      if (hasInjection && blocked > 0) return ok(id, `Security evaluation active — injection detection + ${blocked} enforcement actions`);
      if (hasInjection || blocked > 0) return partial(id, "Partial security evaluation", "Enable injection detection and review enforcement statistics");
      return fail(id, "No security evaluation configured", "Add createInjectionGuard() and review enforcement outcomes");
    }
    case "measure-2.5":
      return config.policiesTested
        ? ok(id, "Policy testing confirmed via dry-run or enforcement scenarios")
        : partial(id, "Policy testing not confirmed", "Test policies with fleetDryRun() or representative enforcement scenarios");
    case "measure-4.1": {
      const count = await governance.audit.count();
      if (count > 0) return ok(id, `${count} audit event(s) available for stakeholder reporting`);
      return fail(id, "No measurement results documented", "Enable audit logging for queryable results");
    }

    // MANAGE
    case "manage-1.1": {
      if (rules.length >= 2) return ok(id, `${rules.length} prioritized policy rules configured`);
      if (rules.length === 1) return partial(id, "Single policy rule configured", "Add multiple rules with varying priorities for comprehensive risk treatment");
      return fail(id, "No risk treatment plans", "Configure policy rules via blockTools(), rateLimit(), requireApproval()");
    }
    case "manage-2.1": {
      const outcomes = new Set(rules.map((r) => r.outcome));
      if (outcomes.size >= 2) return ok(id, `Graduated risk response: ${[...outcomes].join(", ")}`);
      if (rules.length > 0) return partial(id, "Single outcome level configured", "Use multiple outcome types (block, warn, require_approval) for graduated response");
      return fail(id, "No risk response configured", "Add policies with different outcome levels");
    }
    case "manage-3.1": {
      const count = await governance.audit.count();
      if (count > 0 && agents.some((a) => a.compositeScore > 0))
        return ok(id, "Continuous monitoring active via audit trail and behavioral scoring");
      if (count > 0) return partial(id, "Audit trail active but behavioral scoring not configured");
      return fail(id, "No continuous monitoring", "Enable audit logging and agent scoring for ongoing risk monitoring");
    }
    case "manage-4.1":
      return ok(id, "Kill switch available at priority 999 for emergency incident response");

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
