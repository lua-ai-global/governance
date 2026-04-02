/**
 * ISO/IEC 42001 AI Management System Definitions
 *
 * Maps ISO 42001 clauses to SDK features.
 * Assessment logic is in iso-42001.ts.
 */

import type {
  ComplianceStatus,
  RequirementAssessment,
  ArticleAssessment,
} from "./compliance-articles.js";

export type { ComplianceStatus, RequirementAssessment, ArticleAssessment };

// ─── Types ───────────────────────────────────────────────────

export interface IsoClause {
  id: string;
  title: string;
  description: string;
  requirements: IsoRequirement[];
}

export interface IsoRequirement {
  id: string;
  requirement: string;
  sdkFeature: string;
  checkDescription: string;
  automatable: boolean;
}

export interface Iso42001Report {
  overallScore: number;
  status: ComplianceStatus;
  clauses: ArticleAssessment[];
  agentsAssessed: number;
  criticalGaps: string[];
  recommendations: string[];
  generatedAt: string;
}

// ─── Clause Definitions ─────────────────────────────────────

export const ISO_42001_CLAUSES: IsoClause[] = [
  {
    id: "4",
    title: "Context of the Organization",
    description: "Understanding the organization and its context, needs of interested parties, and scope of the AIMS.",
    requirements: [
      {
        id: "iso-4.1",
        requirement: "Determine external and internal issues relevant to AI management",
        sdkFeature: "Agent registration with owner, framework, description — documents organizational context",
        checkDescription: "Agents are registered with ownership and purpose documentation",
        automatable: true,
      },
      {
        id: "iso-4.3",
        requirement: "Determine the scope of the AI management system",
        sdkFeature: "Governance instance with defined policies, storage, and agent registry",
        checkDescription: "Governance is configured with policies and agents registered",
        automatable: true,
      },
    ],
  },
  {
    id: "5",
    title: "Leadership",
    description: "Top management commitment, policy establishment, and organizational roles.",
    requirements: [
      {
        id: "iso-5.2",
        requirement: "Establish an AI policy appropriate to the organization",
        sdkFeature: "Policy engine with named, documented rules — policies are code-defined",
        checkDescription: "Policy rules are configured with names and reasons",
        automatable: true,
      },
      {
        id: "iso-5.3",
        requirement: "Assign roles, responsibilities, and authorities for AI management",
        sdkFeature: "Agent registration with owner field — accountability is tracked",
        checkDescription: "All agents have designated owners",
        automatable: true,
      },
    ],
  },
  {
    id: "6",
    title: "Planning",
    description: "Actions to address risks and opportunities, AI objectives, and planning of changes.",
    requirements: [
      {
        id: "iso-6.1",
        requirement: "Determine risks and opportunities for the AI management system",
        sdkFeature: "7-dimension governance scoring — quantifies risks across identity, permissions, guardrails, etc.",
        checkDescription: "Agents are scored with dimensional risk assessment",
        automatable: true,
      },
      {
        id: "iso-6.2",
        requirement: "Establish AI objectives and plans to achieve them",
        sdkFeature: "Governance levels (0-4) define progressive autonomy targets",
        checkDescription: "Governance levels are assigned and tracked",
        automatable: true,
      },
    ],
  },
  {
    id: "8",
    title: "Operation",
    description: "Operational planning, AI risk assessment, and AI risk treatment.",
    requirements: [
      {
        id: "iso-8.2",
        requirement: "Perform AI risk assessment at planned intervals",
        sdkFeature: "Fleet scoring + behavioral scorer — continuous risk monitoring",
        checkDescription: "Agent scoring is active with audit trail",
        automatable: true,
      },
      {
        id: "iso-8.3",
        requirement: "Implement the AI risk treatment plan",
        sdkFeature: "Policy enforcement with 4 outcome levels (allow, warn, require_approval, block)",
        checkDescription: "Policies use graduated outcomes for risk treatment",
        automatable: true,
      },
      {
        id: "iso-8.4",
        requirement: "AI system impact assessment",
        sdkFeature: "Dry-run simulation — test policy impact before deployment",
        checkDescription: "Policy testing has been performed",
        automatable: false,
      },
    ],
  },
  {
    id: "9",
    title: "Performance Evaluation",
    description: "Monitoring, measurement, analysis, evaluation, internal audit, and management review.",
    requirements: [
      {
        id: "iso-9.1",
        requirement: "Monitor, measure, analyze, and evaluate AI system performance",
        sdkFeature: "Metrics collector + audit trail — enforcement stats, scoring trends",
        checkDescription: "Audit trail is active with queryable events",
        automatable: true,
      },
      {
        id: "iso-9.2",
        requirement: "Conduct internal audits at planned intervals",
        sdkFeature: "HMAC-SHA256 tamper-evident audit trail with verification",
        checkDescription: "Audit integrity is enabled and verifiable",
        automatable: false,
      },
    ],
  },
  {
    id: "10",
    title: "Improvement",
    description: "Nonconformity, corrective action, and continual improvement.",
    requirements: [
      {
        id: "iso-10.1",
        requirement: "React to nonconformities and take corrective action",
        sdkFeature: "Kill switch (priority 999) for immediate incident response + behavioral drift detection",
        checkDescription: "Kill switch is available for incident response",
        automatable: true,
      },
      {
        id: "iso-10.2",
        requirement: "Continually improve the AI management system",
        sdkFeature: "Behavioral scorer adjusts governance over time based on observed audit data",
        checkDescription: "Agents are scored and behavioral tracking is active",
        automatable: true,
      },
    ],
  },
];

/** Get the list of ISO 42001 clauses tracked by this module */
export function getIsoClauses(): IsoClause[] {
  return ISO_42001_CLAUSES;
}
