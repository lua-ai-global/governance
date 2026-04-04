/**
 * governance-sdk — OWASP Top 10 for Agentic Applications Assessment
 *
 * Assesses governance configuration against the OWASP Agentic Security Top 10 (2026).
 * Risk definitions are in owasp-agentic-articles.ts.
 */

import type { StoredAgent, GovernanceInstance } from "./index.js";
import type { ComplianceStatus, RequirementAssessment, ArticleAssessment } from "./compliance-articles.js";
import { OWASP_AGENTIC_RISKS, type OwaspAgenticReport } from "./owasp-agentic-articles.js";

export type { OwaspAgenticRisk, OwaspRequirement, OwaspAgenticReport } from "./owasp-agentic-articles.js";
export { getOwaspRisks } from "./owasp-agentic-articles.js";

// ─── Assessment Config ───────────────────────────────────────

export interface OwaspAssessmentConfig {
  governance: GovernanceInstance;
  agents: StoredAgent[];
  auditIntegrity?: boolean;
  injectionDetection?: boolean;
  outputFiltering?: boolean;
  a2aGovernance?: boolean;
}

// ─── Assessment ─────────────────────────────────────────────

export async function assessOwaspAgentic(
  config: OwaspAssessmentConfig,
): Promise<OwaspAgenticReport> {
  const riskAssessments: ArticleAssessment[] = [];

  for (const risk of OWASP_AGENTIC_RISKS) {
    const reqAssessments: RequirementAssessment[] = [];
    for (const req of risk.requirements) {
      reqAssessments.push(await assessRequirement(req.id, config));
    }

    const compliantCount = reqAssessments.filter((r) => r.status === "compliant").length;
    const partialCount = reqAssessments.filter((r) => r.status === "partial").length;
    const total = reqAssessments.length;
    const score = Math.round(((compliantCount + partialCount * 0.5) / total) * 100);
    const coverage: ComplianceStatus =
      score >= 80 ? "compliant" : score >= 40 ? "partial" : "non-compliant";

    riskAssessments.push({
      article: risk.id,
      title: risk.title,
      coverage,
      score,
      requirements: reqAssessments,
      deadline: "",
      maxFine: "",
    });
  }

  const overallScore = Math.round(
    riskAssessments.reduce((sum, a) => sum + a.score, 0) / riskAssessments.length,
  );
  const status: ComplianceStatus =
    overallScore >= 80 ? "compliant" : overallScore >= 40 ? "partial" : "non-compliant";

  const criticalGaps = riskAssessments.flatMap((a) =>
    a.requirements
      .filter((r) => r.status === "non-compliant")
      .map((r) => `${a.title} (${a.article}): ${r.evidence}`),
  );

  const recommendations = riskAssessments
    .flatMap((a) => a.requirements.filter((r) => r.remediation).map((r) => r.remediation!))
    .filter((v, i, arr) => arr.indexOf(v) === i);

  return {
    overallScore,
    status,
    risks: riskAssessments,
    agentsAssessed: config.agents.length,
    criticalGaps,
    recommendations,
    generatedAt: new Date().toISOString(),
    risksCovered: riskAssessments.filter((r) => r.coverage !== "non-compliant").length,
    risksTotal: OWASP_AGENTIC_RISKS.length,
  };
}

// ─── Requirement Assessors ───────────────────────────────────

async function assessRequirement(
  id: string,
  config: OwaspAssessmentConfig,
): Promise<RequirementAssessment> {
  const { governance, agents } = config;
  const rules = governance.policies.getRules();

  switch (id) {
    // AA-01: Excessive Agency
    case "aa01-tool-restriction": {
      const hasToolPolicy = rules.some((r) =>
        r.condition.type === "tool_blocked" || r.condition.type === "tool_allowed",
      );
      if (hasToolPolicy) return ok(id, "Tool restriction policies configured");
      return fail(id, "No tool restriction policies", "Add blockTools() or allowOnlyTools() to restrict agent tool access");
    }
    case "aa01-governance-level": {
      const hasLevelPolicy = rules.some((r) => r.condition.type === "agent_level");
      if (hasLevelPolicy && agents.every((a) => a.compositeScore > 0))
        return ok(id, "Governance levels enforced with scored agents");
      if (agents.some((a) => a.compositeScore > 0)) return partial(id, "Agents scored but no level enforcement policy");
      return fail(id, "No governance level enforcement", "Add requireLevel() and score agents via gov.register()");
    }

    // AA-02: Unrestricted Resource Consumption
    case "aa02-token-budget": {
      if (rules.some((r) => r.condition.type === "token_limit"))
        return ok(id, "Token budget policy configured");
      return fail(id, "No token budget configured", "Add tokenBudget() to limit per-session token consumption");
    }
    case "aa02-rate-limiting": {
      if (rules.some((r) => r.condition.type === "rate_limit"))
        return ok(id, "Rate limiting policy configured");
      return fail(id, "No rate limiting configured", "Add rateLimit() to throttle agent actions");
    }

    // AA-03: Supply Chain Vulnerabilities
    case "aa03-tool-inventory": {
      if (agents.length === 0) return fail(id, "No agents registered", "Register agents with tools list via gov.register()");
      const withTools = agents.filter((a) => a.tools && a.tools.length > 0);
      if (withTools.length === agents.length) return ok(id, `${agents.length} agent(s) have documented tool inventory`);
      return partial(id, `${withTools.length}/${agents.length} agents have tools documented`);
    }
    case "aa03-tool-validation": {
      const hasInjection = rules.some((r) => r.condition.type === "injection_guard");
      const hasOutput = rules.some((r) => r.condition.type === "sensitive_data_filter" || r.condition.type === "output_pattern");
      if (hasInjection && hasOutput) return ok(id, "Input injection detection and output filtering active");
      if (hasInjection || hasOutput) return partial(id, "Partial input/output validation", "Add both injection_guard and sensitiveDataFilter() policies");
      return fail(id, "No tool input/output validation", "Add createInjectionGuard() and sensitiveDataFilter() policies");
    }

    // AA-04: Data Leakage
    case "aa04-output-filtering": {
      if (rules.some((r) => r.condition.type === "sensitive_data_filter"))
        return ok(id, "Sensitive data output filtering configured");
      if (config.outputFiltering) return ok(id, "Output filtering confirmed");
      return fail(id, "No output filtering for sensitive data", "Add sensitiveDataFilter() to scan outputs for credentials and PII");
    }
    case "aa04-audit-trail": {
      const count = await governance.audit.count();
      if (count > 0) return ok(id, `${count} audit event(s) logged for data access tracking`);
      return fail(id, "No audit events recorded", "Enable audit logging via gov.enforce() or gov.audit.log()");
    }

    // AA-05: Indirect Prompt Injection
    case "aa05-injection-detection": {
      if (rules.some((r) => r.condition.type === "injection_guard"))
        return ok(id, "Injection guard policy configured (64+ patterns, 7 categories)");
      if (config.injectionDetection) return ok(id, "Injection detection confirmed");
      return fail(id, "No injection detection configured", "Add createInjectionGuard() to scan inputs for prompt injection");
    }
    case "aa05-cross-field-scan": {
      const hasInjection = rules.some((r) => r.condition.type === "injection_guard");
      if (hasInjection) return ok(id, "Injection guard includes cross-field recursive scanning");
      return partial(id, "Cross-field scanning not active without injection guard", "Enable createInjectionGuard() for automatic cross-field scanning");
    }

    // AA-06: Inadequate Sandboxing
    case "aa06-action-enforcement": {
      const enforced = await governance.audit.count({ outcome: "block" });
      if (enforced > 0) return ok(id, `Before-action enforcement active — ${enforced} action(s) blocked`);
      if (rules.length > 0) return partial(id, "Policies configured but no actions blocked yet");
      return fail(id, "No before-action enforcement", "Integrate gov.enforce() into your agent pipeline");
    }
    case "aa06-scope-boundaries": {
      const hasScope = rules.some((r) =>
        r.condition.type === "scope_boundary" || r.condition.type === "network_allowlist",
      );
      if (hasScope) return ok(id, "Scope boundary or network allowlist configured");
      return partial(id, "No explicit scope boundaries", "Add scopeBoundary() or networkAllowlist() for path/domain restrictions");
    }

    // AA-07: Over-Reliance on Agent Output
    case "aa07-human-oversight": {
      if (rules.some((r) => r.outcome === "require_approval"))
        return ok(id, "Human approval required for sensitive operations");
      return fail(id, "No human-in-the-loop policy", "Add requireApproval() for high-stakes agent actions");
    }
    case "aa07-output-validation": {
      const hasPostprocess = rules.some((r) => r.stage === "postprocess");
      if (hasPostprocess) return ok(id, "Postprocess output validation configured");
      return partial(id, "No postprocess output validation", "Add outputPattern() or outputLength() policies for output scanning");
    }

    // AA-08: Insufficient Logging
    case "aa08-audit-logging": {
      const count = await governance.audit.count();
      if (count > 0) return ok(id, `Comprehensive audit trail with ${count} event(s)`);
      return fail(id, "No audit events recorded", "Enable audit logging via gov.enforce() or gov.audit.log()");
    }
    case "aa08-tamper-evidence":
      return config.auditIntegrity
        ? ok(id, "HMAC-SHA256 tamper-evident audit logging enabled")
        : partial(id, "Audit logs not tamper-evident", "Enable createIntegrityAudit() for hash-chained logging");

    // AA-09: Insecure Inter-Agent Communication
    case "aa09-agent-identity": {
      if (agents.length === 0) return fail(id, "No agents registered", "Register agents with identity metadata");
      const scored = agents.filter((a) => a.compositeScore > 0);
      if (scored.length === agents.length) return ok(id, `${agents.length} agent(s) registered with identity scoring`);
      return partial(id, `${scored.length}/${agents.length} agents have identity scores`);
    }
    case "aa09-communication-policy":
      return config.a2aGovernance
        ? ok(id, "Inter-agent communication governed via A2A adapter")
        : partial(id, "No inter-agent governance configured", "Use the A2A governance adapter for agent-to-agent communication");

    // AA-10: Rogue Agents
    case "aa10-kill-switch":
      return ok(id, "Kill switch available at priority 999 with quarantine capability");
    case "aa10-behavioral-scoring": {
      if (agents.length === 0) return fail(id, "No agents registered for behavioral monitoring", "Register agents to enable behavioral scoring");
      const scored = agents.filter((a) => a.compositeScore > 0);
      if (scored.length === agents.length) return ok(id, `${agents.length} agent(s) scored with behavioral drift tracking`);
      return partial(id, `${scored.length}/${agents.length} agents scored`, "Score all agents via gov.register() or gov.score()");
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
