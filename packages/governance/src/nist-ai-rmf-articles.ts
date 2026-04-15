/**
 * NIST AI Risk Management Framework (AI RMF 1.0) Definitions
 *
 * Maps the 4 core functions and their categories to SDK features.
 * Assessment logic is in nist-ai-rmf.ts.
 *
 * Reference: https://www.nist.gov/artificial-intelligence/ai-risk-management-framework
 */

import type {
  ComplianceStatus,
  RequirementAssessment,
  ArticleAssessment,
} from "./compliance-articles.js";

export type { ComplianceStatus, RequirementAssessment, ArticleAssessment };

// ─── Types ───────────────────────────────────────────────────

/** NIST AI RMF function definition */
export interface NistFunction {
  id: string;
  title: string;
  description: string;
  requirements: NistRequirement[];
}

/** A specific checkable requirement within a function */
export interface NistRequirement {
  id: string;
  category: string;
  requirement: string;
  sdkFeature: string;
  checkDescription: string;
  automatable: boolean;
}

/** Full NIST AI RMF compliance report */
export interface NistAiRmfReport {
  overallScore: number;
  status: ComplianceStatus;
  functions: ArticleAssessment[];
  agentsAssessed: number;
  criticalGaps: string[];
  recommendations: string[];
  generatedAt: string;
  /** Version of the standard this report targets. */
  standardVersion?: string;
  /** Human-readable scope caveat surfaced in the JSON output. */
  scope?: string;
}

// ─── Function Definitions ───────────────────────────────────

export const NIST_AI_RMF_FUNCTIONS: NistFunction[] = [
  {
    id: "GOVERN",
    title: "Govern",
    description: "Cultivate and implement a culture of risk management within organizations designing, developing, deploying, or using AI systems.",
    requirements: [
      {
        id: "govern-1.1",
        category: "Govern 1: Policies, processes, procedures, and practices",
        requirement: "Legal and regulatory requirements involving AI are understood, managed, and documented",
        sdkFeature: "EU AI Act compliance module + OWASP Agentic mapping — structured compliance tracking",
        checkDescription: "At least one compliance framework is assessed",
        automatable: true,
      },
      {
        id: "govern-1.2",
        category: "Govern 1: Policies, processes, procedures, and practices",
        requirement: "Trustworthy AI policies are established and available",
        sdkFeature: "Policy engine with named, documented rules — policies are code-defined and auditable",
        checkDescription: "Policy rules are configured with names and reasons",
        automatable: true,
      },
      {
        id: "govern-4.1",
        category: "Govern 4: Organizational practices",
        requirement: "Organizational practices are in place for governance of AI risks",
        sdkFeature: "Governance instance with storage, policy engine, audit trail, and scoring",
        checkDescription: "Governance instance is configured with storage and policies",
        automatable: true,
      },
    ],
  },
  {
    id: "MAP",
    title: "Map",
    description: "Identify and understand the context in which AI systems operate, including the potential impacts.",
    requirements: [
      {
        id: "map-1.1",
        category: "Map 1: Context is established",
        requirement: "Intended purposes, potentially beneficial uses, context of use, and users are understood",
        sdkFeature: "Agent registration with description, owner, framework, channels, tools metadata",
        checkDescription: "All agents have documented purpose (description) and owner",
        automatable: true,
      },
      {
        id: "map-2.1",
        category: "Map 2: Categorization of AI system",
        requirement: "The AI system is categorized based on risk level",
        sdkFeature: "7-dimension governance scoring with progressive autonomy levels (0-4)",
        checkDescription: "All agents are scored and assigned governance levels",
        automatable: true,
      },
      {
        id: "map-3.1",
        category: "Map 3: AI capabilities and limitations",
        requirement: "AI capabilities, targeted usage, goals, and expected benefits are understood",
        sdkFeature: "Agent registration with tools list, permissions, and capability metadata",
        checkDescription: "All agents have tools and permissions documented",
        automatable: true,
      },
    ],
  },
  {
    id: "MEASURE",
    title: "Measure",
    description: "Employ quantitative, qualitative, or mixed-method tools to analyze, assess, benchmark, and monitor AI risk.",
    requirements: [
      {
        id: "measure-1.1",
        category: "Measure 1: Appropriate methods for risk assessment",
        requirement: "Approaches and metrics for measurement of AI risks are selected",
        sdkFeature: "7-dimension scoring (identity, permissions, observability, guardrails, auditability, compliance, lifecycle)",
        checkDescription: "Governance scoring is active with dimensional breakdowns",
        automatable: true,
      },
      {
        id: "measure-2.1",
        category: "Measure 2: AI systems are evaluated",
        requirement: "Evaluations are conducted for safety, security, and resilience",
        sdkFeature: "Injection detection (64+ patterns), enforcement statistics, fleet scoring",
        checkDescription: "Injection detection is configured and enforcement is active",
        automatable: true,
      },
      {
        id: "measure-2.5",
        category: "Measure 2: AI systems are evaluated",
        requirement: "The AI system is tested for security risks and resilience",
        sdkFeature: "Dry-run simulation — test policies against scenarios without affecting production",
        checkDescription: "Policy testing has been performed (dry-run or enforcement playground)",
        automatable: false,
      },
      {
        id: "measure-4.1",
        category: "Measure 4: Feedback mechanisms",
        requirement: "Measurement results are documented and shared with relevant stakeholders",
        sdkFeature: "Audit trail with queryable events, fleet scoring reports, compliance reports",
        checkDescription: "Audit events and scoring results are accessible",
        automatable: true,
      },
    ],
  },
  {
    id: "MANAGE",
    title: "Manage",
    description: "Allocate risk resources to mapped and measured AI risks on a regular basis.",
    requirements: [
      {
        id: "manage-1.1",
        category: "Manage 1: AI risk treatment plans",
        requirement: "Plans for addressing AI risk are prioritized and implemented",
        sdkFeature: "Policy engine with prioritized rules — higher priority rules evaluate first",
        checkDescription: "Multiple policy rules configured with varying priorities",
        automatable: true,
      },
      {
        id: "manage-2.1",
        category: "Manage 2: AI risks are treated",
        requirement: "Risks are responded to based on impact assessment",
        sdkFeature: "Four outcome levels (allow, warn, require_approval, block) with severity-based routing",
        checkDescription: "Policies use multiple outcome levels for graduated response",
        automatable: true,
      },
      {
        id: "manage-3.1",
        category: "Manage 3: Risk management is continuous",
        requirement: "AI risks and benefits are regularly monitored",
        sdkFeature: "Behavioral scorer tracks drift, audit trail enables continuous monitoring",
        checkDescription: "Audit trail is active and agents have been re-scored",
        automatable: true,
      },
      {
        id: "manage-4.1",
        category: "Manage 4: Incident response",
        requirement: "Plans for incident response, recovery, and communication are in place",
        sdkFeature: "Kill switch (priority 999) for emergency halt, fleet-wide kill capability",
        checkDescription: "Kill switch is available for incident response",
        automatable: true,
      },
    ],
  },
];

/** Get the list of NIST AI RMF functions tracked by this module */
export function getNistFunctions(): NistFunction[] {
  return NIST_AI_RMF_FUNCTIONS;
}
