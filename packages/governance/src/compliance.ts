/**
 * governance-sdk — EU AI Act Compliance Assessment
 *
 * Assesses governance configuration against EU AI Act article requirements.
 * Article definitions are in compliance-articles.ts.
 *
 * Enforcement deadline: August 2, 2026
 */

import type { StoredAgent, GovernanceInstance } from "./index.js";
import {
  EU_AI_ACT_ARTICLES,
  type ArticleRequirement,
  type ComplianceStatus,
  type RequirementAssessment,
  type ArticleAssessment,
  type ComplianceReport,
} from "./compliance-articles.js";

// Re-export all types from articles module
export type {
  EuAiActArticle,
  ArticleRequirement,
  ComplianceStatus,
  RequirementAssessment,
  ArticleAssessment,
  ComplianceReport,
} from "./compliance-articles.js";
export { getArticles, getDaysUntilDeadline } from "./compliance-articles.js";

// ─── Assessment Config ───────────────────────────────────────

/** Configuration for compliance assessment */
export interface ComplianceAssessmentConfig {
  governance: GovernanceInstance;
  agents: StoredAgent[];
  auditIntegrity?: boolean;
  humanOversight?: boolean;
  logRetention?: boolean;
  configVersionControlled?: boolean;
  policiesTested?: boolean;
}

// ─── Compliance Assessment ───────────────────────────────────

export async function assessCompliance(
  config: ComplianceAssessmentConfig,
): Promise<ComplianceReport> {
  const { agents } = config;
  const articleAssessments: ArticleAssessment[] = [];

  for (const article of EU_AI_ACT_ARTICLES) {
    const reqAssessments: RequirementAssessment[] = [];
    for (const req of article.requirements) {
      reqAssessments.push(await assessRequirement(req, config));
    }

    const compliantCount = reqAssessments.filter((r) => r.status === "compliant").length;
    const partialCount = reqAssessments.filter((r) => r.status === "partial").length;
    const total = reqAssessments.length;
    const score = Math.round(((compliantCount + partialCount * 0.5) / total) * 100);

    const coverage: ComplianceStatus =
      score >= 80 ? "compliant" : score >= 40 ? "partial" : "non-compliant";

    articleAssessments.push({
      article: article.article,
      title: article.title,
      coverage,
      score,
      requirements: reqAssessments,
      deadline: article.deadline,
      maxFine: article.maxFine,
    });
  }

  const overallScore = Math.round(
    articleAssessments.reduce((sum, a) => sum + a.score, 0) / articleAssessments.length,
  );

  const status: ComplianceStatus =
    overallScore >= 80 ? "compliant" : overallScore >= 40 ? "partial" : "non-compliant";

  const criticalGaps = articleAssessments.flatMap((a) =>
    a.requirements
      .filter((r) => r.status === "non-compliant")
      .map((r) => `${a.title} (Art. ${a.article}): ${r.evidence}`),
  );

  const recommendations = articleAssessments
    .flatMap((a) => a.requirements.filter((r) => r.remediation).map((r) => r.remediation!))
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const deadline = new Date("2026-08-02");
  const now = new Date();
  const daysUntilDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  return {
    overallScore,
    status,
    articles: articleAssessments,
    agentsAssessed: agents.length,
    criticalGaps,
    recommendations,
    generatedAt: new Date().toISOString(),
    daysUntilDeadline,
  };
}

// ─── Requirement Assessors ───────────────────────────────────

async function assessRequirement(
  req: ArticleRequirement,
  config: ComplianceAssessmentConfig,
): Promise<RequirementAssessment> {
  const { governance, agents } = config;

  switch (req.id) {
    case "art9-risk-identification": {
      const rules = governance.policies.getRules();
      if (rules.length > 0) return ok(req.id, `${rules.length} policy rule(s) configured`);
      return fail(req.id, "No policy rules configured", "Add policy rules via blockTools(), requireLevel(), or custom rules");
    }
    case "art9-risk-mitigation": {
      const blockedCount = await governance.audit.count({ outcome: "blocked" });
      if (blockedCount > 0) return ok(req.id, `${blockedCount} action(s) blocked by enforcement`);
      const rules = governance.policies.getRules();
      if (rules.length > 0) return partial(req.id, "Policies configured but no actions blocked yet");
      return fail(req.id, "No enforcement active", "Enable policy enforcement with gov.enforce() in your agent pipeline");
    }
    case "art9-residual-risk": {
      if (agents.length === 0) return fail(req.id, "No agents registered", "Register agents via gov.register() to enable risk scoring");
      const allScored = agents.every((a) => a.compositeScore > 0);
      if (allScored) return ok(req.id, `${agents.length} agent(s) scored with 7-dimension assessment`);
      return partial(req.id, "Some agents not yet scored", "Re-score agents via gov.score(agentId)");
    }
    case "art9-testing":
      return config.policiesTested ? ok(req.id, "Policy rules have been tested") : partial(req.id, "Policy testing not confirmed", "Test policies with representative scenarios using the enforcement playground");

    case "art11-system-description": {
      if (agents.length === 0) return fail(req.id, "No agents registered", "Register agents with description and owner fields");
      const documented = agents.filter((a) => a.description && a.owner);
      if (documented.length === agents.length) return ok(req.id, `${agents.length} agent(s) have description and owner`);
      return partial(req.id, `${documented.length}/${agents.length} agents documented`, "Add description and owner to all agent registrations");
    }
    case "art11-capabilities": {
      if (agents.length === 0) return fail(req.id, "No agents registered");
      const withTools = agents.filter((a) => a.tools && a.tools.length > 0);
      if (withTools.length === agents.length) return ok(req.id, `${agents.length} agent(s) have documented tools/capabilities`);
      return partial(req.id, `${withTools.length}/${agents.length} have documented tools`, "Add tools list to all agent registrations");
    }
    case "art11-monitoring":
      return config.configVersionControlled ? ok(req.id, "Governance config is version-controlled") : partial(req.id, "Version control not confirmed", "Commit governance.config.ts to version control");

    case "art12-automatic-logging": {
      const totalEvents = await governance.audit.count();
      if (totalEvents > 0) return ok(req.id, `${totalEvents} audit event(s) recorded`);
      return fail(req.id, "No audit events recorded", "Enable audit logging via gov.audit.log() or gov.enforce()");
    }
    case "art12-traceability": {
      const events = await governance.audit.query({ limit: 1 });
      if (events.length > 0) {
        const e = events[0];
        if (e.agentId && e.eventType && e.outcome && e.createdAt)
          return ok(req.id, "Audit events contain agent ID, event type, outcome, and timestamp");
      }
      return partial(req.id, "Audit events lack sufficient context", "Ensure all audit events include agentId, eventType, outcome, and detail");
    }
    case "art12-integrity":
      return config.auditIntegrity ? ok(req.id, "HMAC-SHA256 tamper-evident audit logging enabled") : fail(req.id, "Audit logs are not tamper-evident", "Enable createIntegrityAudit() for HMAC-SHA256 hash-chained logging");
    case "art12-retention":
      return config.logRetention ? ok(req.id, "Log retention policy configured") : partial(req.id, "No explicit retention policy", "Configure log retention in your storage adapter");

    case "art14-intervention": {
      const rules = governance.policies.getRules();
      if (rules.some((r) => r.outcome === "require_approval")) return ok(req.id, "requireApproval() policy configured for human review");
      if (config.humanOversight) return ok(req.id, "Human oversight mechanism confirmed");
      return fail(req.id, "No human oversight mechanism", "Add requireApproval() policy for sensitive operations");
    }
    case "art14-understanding":
      return (agents.length > 0 && agents.every((a) => a.compositeScore > 0)) ? ok(req.id, "7-dimension scoring with explainable evidence for all agents") : partial(req.id, "Not all agents have explainable assessments", "Ensure all agents are scored with gov.score()");
    case "art14-monitoring": {
      const totalEvents = await governance.audit.count();
      if (totalEvents > 0) return ok(req.id, `Audit trail active with ${totalEvents} events queryable in real-time`);
      return fail(req.id, "No monitoring data available", "Enable audit logging for real-time monitoring");
    }

    case "art15-resilience": {
      const rules = governance.policies.getRules();
      if (rules.some((r) => r.condition.type === "token_limit" || r.condition.type === "rate_limit"))
        return ok(req.id, "Defensive policies configured (token budget and/or rate limiting)");
      return partial(req.id, "No defensive policies", "Add tokenBudget() and rateLimit() policies");
    }
    case "art15-security": {
      const hasAuth = agents.some((a) => a.metadata && (a.metadata as Record<string, unknown>)["hasAuth"]);
      if (config.auditIntegrity && hasAuth) return ok(req.id, "Audit integrity + agent authentication configured");
      if (config.auditIntegrity) return partial(req.id, "Audit integrity enabled but agent auth not confirmed");
      return fail(req.id, "No cybersecurity measures", "Enable createIntegrityAudit() and configure agent authentication");
    }

    case "art50-disclosure": {
      if (agents.length === 0) return fail(req.id, "No agents registered", "Register agents with disclosure metadata via gov.register()");
      const disclosed = agents.filter((a) => a.name && a.description);
      if (disclosed.length === agents.length) return ok(req.id, `${agents.length} agent(s) have identity and description for disclosure`);
      return partial(req.id, `${disclosed.length}/${agents.length} agents have disclosure metadata`);
    }
    case "art50-content-marking": {
      const totalEvents = await governance.audit.count();
      if (totalEvents > 0 && config.auditIntegrity) return ok(req.id, "Audit trail with integrity metadata provides content provenance");
      if (totalEvents > 0) return partial(req.id, "Audit trail active but no integrity metadata for provenance", "Enable createIntegrityAudit() for verifiable content provenance");
      return fail(req.id, "No content provenance tracking", "Enable audit logging with integrity for machine-readable content marking");
    }

    default:
      return { requirementId: req.id, status: "not-applicable", evidence: "Unknown requirement" };
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
