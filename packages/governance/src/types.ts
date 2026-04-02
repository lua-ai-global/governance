/**
 * governance-sdk — Core type system for agent governance.
 * Framework-agnostic types for agent registration, scoring, and fleet management.
 */

/** Supported agent frameworks */
export type AgentFramework =
  | "mastra"
  | "langchain"
  | "crewai"
  | "autogen"
  | "openai"
  | "vercel-ai"
  | "mcp"
  | "bedrock"
  | "genkit"
  | "semantic-kernel"
  | "anthropic"
  | "mistral"
  | "ollama"
  | "e2b"
  | "composio"
  | "custom"
  | "unknown";

/** Agent lifecycle status */
export type AgentStatus =
  | "registered"
  | "assessed"
  | "approved"
  | "flagged"
  | "deprecated"
  | "quarantined";

/** The seven governance dimensions */
export type ScoreDimension =
  | "identity"
  | "permissions"
  | "observability"
  | "guardrails"
  | "auditability"
  | "compliance"
  | "lifecycle";

/** Governance level mapped from composite score */
export interface GovernanceLevel {
  level: 0 | 1 | 2 | 3 | 4;
  label: string;
  autonomy: string;
  minScore: number;
  maxScore: number;
}

/** Individual dimension scoring result */
export interface DimensionResult {
  dimension: ScoreDimension;
  score: number;
  weight: number;
  evidence: Record<string, boolean | number | string>;
}

/** Complete governance assessment for an agent */
export interface GovernanceAssessment {
  agentId: string;
  agentName: string;
  compositeScore: number;
  level: GovernanceLevel;
  dimensions: DimensionResult[];
  status: AgentStatus;
  assessedAt: string;
  recommendations: string[];
}

/** Agent registration input */
export interface AgentRegistration {
  name: string;
  framework: AgentFramework;
  description?: string;
  owner: string;
  version?: string;
  channels?: string[];
  tools?: string[];
  hasAuth?: boolean;
  hasGuardrails?: boolean;
  hasObservability?: boolean;
  hasAuditLog?: boolean;
  permissions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Fleet-level governance summary */
export interface FleetSummary {
  totalAgents: number;
  averageScore: number;
  fleetLevel: GovernanceLevel;
  byStatus: Record<AgentStatus, number>;
  byFramework: Record<AgentFramework, number>;
  byLevel: Record<number, number>;
  highestScoring: { name: string; score: number } | null;
  lowestScoring: { name: string; score: number } | null;
  recommendations: string[];
}
