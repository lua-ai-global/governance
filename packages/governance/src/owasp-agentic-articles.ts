/**
 * OWASP Top 10 for Agentic Applications (2026)
 *
 * Risk definitions for the OWASP Agentic Security Top 10.
 * Assessment logic is in owasp-agentic.ts.
 *
 * Reference: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
 */

import type {
  ComplianceStatus,
  RequirementAssessment,
  ArticleAssessment,
} from "./compliance-articles.js";

// Re-export shared types
export type { ComplianceStatus, RequirementAssessment, ArticleAssessment };

// ─── Types ───────────────────────────────────────────────────

/** OWASP Agentic risk definition */
export interface OwaspAgenticRisk {
  id: string;
  title: string;
  description: string;
  severity: "critical" | "high" | "medium";
  requirements: OwaspRequirement[];
}

/** A specific checkable requirement within a risk */
export interface OwaspRequirement {
  id: string;
  requirement: string;
  sdkFeature: string;
  checkDescription: string;
  automatable: boolean;
}

/** Full OWASP Agentic compliance report */
export interface OwaspAgenticReport {
  overallScore: number;
  status: ComplianceStatus;
  risks: ArticleAssessment[];
  agentsAssessed: number;
  criticalGaps: string[];
  recommendations: string[];
  generatedAt: string;
  risksCovered: number;
  risksTotal: number;
  /** Human-readable scope caveat surfaced in the JSON output. */
  scope?: string;
}

// ─── Risk Definitions ───────────────────────────────────────

export const OWASP_AGENTIC_RISKS: OwaspAgenticRisk[] = [
  {
    id: "OWASP-AA-01",
    title: "Excessive Agency",
    description: "Agents granted too many permissions, tools, or autonomy beyond what is needed for their task.",
    severity: "critical",
    requirements: [
      {
        id: "aa01-tool-restriction",
        requirement: "Restrict agent tool access to the minimum necessary set",
        sdkFeature: "blockTools() and allowOnlyTools() — whitelist/blocklist tool access",
        checkDescription: "At least one tool restriction policy is configured",
        automatable: true,
      },
      {
        id: "aa01-governance-level",
        requirement: "Enforce governance levels that limit agent autonomy",
        sdkFeature: "requireLevel() — gate actions by governance trust level",
        checkDescription: "Agents are scored and governance levels enforced",
        automatable: true,
      },
    ],
  },
  {
    id: "OWASP-AA-02",
    title: "Unrestricted Resource Consumption",
    description: "Agents consuming excessive tokens, API calls, compute, or cost without limits.",
    severity: "high",
    requirements: [
      {
        id: "aa02-token-budget",
        requirement: "Enforce token consumption limits per session",
        sdkFeature: "tokenBudget() — per-session token cap policy",
        checkDescription: "Token budget policy is configured",
        automatable: true,
      },
      {
        id: "aa02-rate-limiting",
        requirement: "Rate-limit agent actions to prevent runaway execution",
        sdkFeature: "rateLimit() — throttle agent requests within time windows",
        checkDescription: "Rate limiting policy is configured",
        automatable: true,
      },
    ],
  },
  {
    id: "OWASP-AA-03",
    title: "Supply Chain Vulnerabilities",
    description: "Compromised tools, MCP servers, or dependencies that agents rely on.",
    severity: "critical",
    requirements: [
      {
        id: "aa03-tool-inventory",
        requirement: "Maintain an inventory of agent tools and dependencies",
        sdkFeature: "Agent registration with tools list — documents agent capabilities",
        checkDescription: "All agents have tools documented in registration",
        automatable: true,
      },
      {
        id: "aa03-tool-validation",
        requirement: "Validate tool inputs and outputs to detect compromised tools",
        sdkFeature: "Injection detection on tool inputs, sensitive data filter on outputs",
        checkDescription: "Injection guard and/or output filtering policies are active",
        automatable: true,
      },
    ],
  },
  {
    id: "OWASP-AA-04",
    title: "Data Leakage",
    description: "Sensitive data exposed through agent outputs, tool calls, or inter-agent communication.",
    severity: "critical",
    requirements: [
      {
        id: "aa04-output-filtering",
        requirement: "Scan agent outputs for credentials, PII, and sensitive data",
        sdkFeature: "sensitiveDataFilter() — 26 patterns for credentials, PII, prompt leaks",
        checkDescription: "Output filtering policy is configured",
        automatable: true,
      },
      {
        id: "aa04-audit-trail",
        requirement: "Log all data access and external requests for post-hoc review",
        sdkFeature: "Audit trail records every action with detail payload",
        checkDescription: "Audit logging is active and recording events",
        automatable: true,
      },
    ],
  },
  {
    id: "OWASP-AA-05",
    title: "Indirect Prompt Injection",
    description: "Malicious instructions embedded in tool outputs, documents, or data that manipulate agent behavior.",
    severity: "critical",
    requirements: [
      {
        id: "aa05-injection-detection",
        requirement: "Detect prompt injection patterns in agent inputs",
        sdkFeature: "createInjectionGuard() — 64+ patterns across 7 categories with base64 decoding",
        checkDescription: "Injection guard policy is configured",
        automatable: true,
      },
      {
        id: "aa05-cross-field-scan",
        requirement: "Scan all input fields including tool outputs for injection attempts",
        sdkFeature: "Cross-field injection detection via extractStrings() recursive scanning",
        checkDescription: "Injection detection is configured with cross-field scanning",
        automatable: true,
      },
    ],
  },
  {
    id: "OWASP-AA-06",
    title: "Inadequate Sandboxing",
    description: "Agents executing actions without proper isolation or containment boundaries.",
    severity: "high",
    requirements: [
      {
        id: "aa06-action-enforcement",
        requirement: "Enforce before-action policies to prevent unauthorized operations",
        sdkFeature: "gov.enforce() — before-action enforcement on every agent operation",
        checkDescription: "Enforcement is integrated into the agent pipeline",
        automatable: true,
      },
      {
        id: "aa06-scope-boundaries",
        requirement: "Define and enforce scope boundaries for file and network access",
        sdkFeature: "scopeBoundary() and networkAllowlist() — path and domain restrictions",
        checkDescription: "Scope boundary or network allowlist policies are configured",
        automatable: true,
      },
    ],
  },
  {
    id: "OWASP-AA-07",
    title: "Over-Reliance on Agent Output",
    description: "Trusting agent outputs without verification, leading to incorrect or harmful actions.",
    severity: "medium",
    requirements: [
      {
        id: "aa07-human-oversight",
        requirement: "Require human approval for high-stakes agent actions",
        sdkFeature: "requireApproval() — gate sensitive operations behind human review",
        checkDescription: "At least one requireApproval policy is configured",
        automatable: true,
      },
      {
        id: "aa07-output-validation",
        requirement: "Validate and scan agent outputs before delivery",
        sdkFeature: "Postprocess stage enforcement — outputPattern() and outputLength() policies",
        checkDescription: "Postprocess output validation is configured",
        automatable: true,
      },
    ],
  },
  {
    id: "OWASP-AA-08",
    title: "Insufficient Logging and Monitoring",
    description: "Lack of audit trails, monitoring, or alerting for agent activity.",
    severity: "high",
    requirements: [
      {
        id: "aa08-audit-logging",
        requirement: "Maintain comprehensive audit trail of all agent actions",
        sdkFeature: "Immutable audit trail with agent ID, event type, outcome, severity, timestamps",
        checkDescription: "Audit trail is active with events recorded",
        automatable: true,
      },
      {
        id: "aa08-tamper-evidence",
        requirement: "Ensure audit logs cannot be tampered with",
        sdkFeature: "HMAC-SHA256 hash-chained audit via createIntegrityAudit()",
        checkDescription: "Tamper-evident audit logging is enabled",
        automatable: false,
      },
    ],
  },
  {
    id: "OWASP-AA-09",
    title: "Insecure Inter-Agent Communication",
    description: "Agents communicating without authentication, authorization, or message integrity.",
    severity: "high",
    requirements: [
      {
        id: "aa09-agent-identity",
        requirement: "Authenticate agent identity before inter-agent communication",
        sdkFeature: "Agent registration with identity scoring + A2A governance adapter",
        checkDescription: "Agents are registered with identity metadata and scored",
        automatable: true,
      },
      {
        id: "aa09-communication-policy",
        requirement: "Enforce policies on inter-agent message exchange",
        sdkFeature: "A2A plugin governs both send and receive with policy enforcement",
        checkDescription: "Inter-agent communication is governed via A2A adapter or equivalent",
        automatable: false,
      },
    ],
  },
  {
    id: "OWASP-AA-10",
    title: "Rogue Agents",
    description: "Agents operating outside their intended boundaries due to hijacking, misconfiguration, or drift.",
    severity: "critical",
    requirements: [
      {
        id: "aa10-kill-switch",
        requirement: "Ability to immediately halt a rogue agent",
        sdkFeature: "Kill switch at priority 999 — overrides all policies, quarantines agent",
        checkDescription: "Kill switch is available and functional",
        automatable: true,
      },
      {
        id: "aa10-behavioral-scoring",
        requirement: "Detect behavioral drift through ongoing monitoring",
        sdkFeature: "Behavioral scorer adjusts governance scores based on observed audit data",
        checkDescription: "Agents are scored and behavioral drift is tracked",
        automatable: true,
      },
    ],
  },
];

/** Get the list of OWASP Agentic risks tracked by this module */
export function getOwaspRisks(): OwaspAgenticRisk[] {
  return OWASP_AGENTIC_RISKS;
}
