/**
 * Types for the Google Genkit governance integration.
 *
 * NOTE: Genkit tools are callable functions with attached metadata
 * (an intersection type), not plain objects with an execute() method.
 * This adapter wraps them as objects for governance enforcement.
 *
 * Mirrors genkit v1.29+ shapes without requiring genkit as a dependency.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Genkit Shapes ──────────────────────────────────────────

/**
 * Genkit tool wrapper for governance.
 *
 * In the actual SDK, ToolAction is a callable function with __action
 * metadata. We model it as an object with explicit call/run methods
 * for governance wrapping purposes.
 */
export interface GenkitTool {
  name: string;
  description: string;
  /** Input schema — Zod schema in real SDK (JSON Schema representation here) */
  inputSchema?: Record<string, unknown>;
  /** Output schema — Zod schema in real SDK (JSON Schema representation here) */
  outputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /**
   * Invoke the tool — maps to calling the ToolAction directly.
   * In the real SDK: `tool(input)` (tools are callable functions).
   */
  call: (input: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  /** @deprecated Use call — tools in Genkit do not have execute() */
  execute?: (input: Record<string, unknown>) => Promise<unknown>;
}

/** Genkit flow shape (flows ARE Actions — callable functions) */
export interface GenkitFlow {
  name: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Call the flow — maps to `flow(input)` */
  call: (input: unknown) => Promise<unknown>;
  /** Run with ActionResult — maps to `flow.run(input)` */
  run?: (input: unknown) => Promise<{ result: unknown }>;
  /** @deprecated Use call */
  execute?: (input: unknown) => Promise<unknown>;
}

/**
 * Genkit model middleware (ModelMiddleware).
 * Operates on GenerateRequest, not raw input.
 * Applied via `use` array in `ai.generate()`.
 */
export type GenkitMiddleware = (
  req: Record<string, unknown>,
  next: (req: Record<string, unknown>) => Promise<Record<string, unknown>>,
) => Promise<Record<string, unknown>>;

// ─── Configuration ──────────────────────────────────────────

export interface GovernGenkitConfig {
  agentName: string;
  owner: string;
  framework?: AgentFramework;
  description?: string;
  version?: string;
  channels?: string[];
  hasAuth?: boolean;
  hasGuardrails?: boolean;
  hasObservability?: boolean;
  permissions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  onBlocked?: (decision: EnforcementDecision, toolName: string) => void;
  onDecision?: (decision: EnforcementDecision, toolName: string) => void;
  actionMapper?: (toolName: string) => PolicyAction;
  sessionTokenTracker?: () => number;
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedGenkitToolsResult {
  tools: GenkitTool[];
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

export interface GovernedGenkitFlowResult {
  flow: GenkitFlow;
  agentId: string;
  score: number;
  level: number;
}
