/**
 * Types for the LlamaIndex governance integration.
 *
 * Mirrors LlamaIndex TypeScript SDK (llamaindex npm) shapes without
 * requiring the SDK as a dependency. Structurally compatible at runtime.
 *
 * Updated March 2026: call() returns ToolOutput per SDK (tool, input,
 * output, isError), call is optional on BaseTool (BaseToolWithCall has it).
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── LlamaIndex Shapes ─────────────────────────────────────

/** JSON-compatible value (mirrors LlamaIndex JSONValue — SDK excludes null) */
export type LlamaIndexJSONValue =
  | string
  | number
  | boolean
  | LlamaIndexJSONValue[]
  | { [key: string]: LlamaIndexJSONValue };

/** LlamaIndex tool shape (mirrors BaseTool / BaseToolWithCall) */
export interface LlamaIndexTool {
  metadata: LlamaIndexToolMetadata;
  /** Call the tool — returns JSONValue per SDK (ToolOutput is created externally by callTool) */
  call?: (input: Record<string, unknown>) => LlamaIndexJSONValue | Promise<LlamaIndexJSONValue>;
}

/** LlamaIndex tool metadata */
export interface LlamaIndexToolMetadata {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** LlamaIndex tool output (mirrors SDK ToolOutput class — created by callTool, not by tools) */
export interface LlamaIndexToolOutput {
  /** The tool that produced this output (required key, may be undefined) */
  tool: LlamaIndexTool | undefined;
  /** The input that was passed to the tool */
  input: Record<string, unknown>;
  /** Tool output — can be any JSON value */
  output: LlamaIndexJSONValue;
  /** Whether the tool execution resulted in an error */
  isError: boolean;
}

/** LlamaIndex query engine tool shape */
export interface LlamaIndexQueryEngineTool {
  metadata: LlamaIndexToolMetadata;
  call?: (input: Record<string, unknown>) => LlamaIndexJSONValue | Promise<LlamaIndexJSONValue>;
  queryEngine?: unknown;
}

/** LlamaIndex agent shape */
export interface LlamaIndexAgent {
  tools: LlamaIndexTool[];
  chat?: (message: string) => Promise<unknown>;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernLlamaIndexConfig {
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

export interface GovernedLlamaIndexToolsResult {
  tools: LlamaIndexTool[];
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

export interface GovernedLlamaIndexAgentResult {
  agent: LlamaIndexAgent;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}
