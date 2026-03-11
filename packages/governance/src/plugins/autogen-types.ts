/**
 * Types for the Microsoft AutoGen governance integration.
 *
 * NOTE: AutoGen is in maintenance mode as of early 2026.
 * Microsoft Agent Framework (combining AutoGen + Semantic Kernel) is the
 * successor. The AG2 project (ag2ai/ag2) is the community-driven fork.
 *
 * These types approximate AutoGen v0.7 (agentchat) Python shapes in
 * TypeScript. AutoGen has no official TypeScript SDK — these are
 * structural mirrors for governance wrapping purposes.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── AutoGen v0.7 Shapes ───────────────────────────────────

/** AutoGen v0.7 FunctionTool shape */
export interface AutoGenTool {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  /** v0.7: run_json(args, cancellation_token) */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  returnValueAsString?: (result: unknown) => string;
  /** v0.7: strict JSON schema enforcement for tool output */
  strict?: boolean;
}

/** @deprecated Use AutoGenTool — v0.2 had optional description */
export type AutoGenToolLegacy = Omit<AutoGenTool, "description"> & { description?: string };

/** AutoGen v0.7 BaseChatAgent shape */
export interface AutoGenAgent {
  name: string;
  description: string;
  tools?: AutoGenTool[];
  /** v0.7: model_client replaces llm_config */
  modelClient?: Record<string, unknown>;
  /** v0.7 required: list of message types this agent can produce */
  producedMessageTypes?: string[];
}

/** AutoGen v0.7+ message types (ChatMessage + AgentEvent) */
export type AutoGenMessageKind =
  | "TextMessage"
  | "MultiModalMessage"
  | "ToolCallRequestEvent"
  | "ToolCallExecutionEvent"
  | "StopMessage"
  | "HandoffMessage"
  | "ToolCallSummaryMessage"
  | "MemoryQueryEvent"
  | "ThoughtEvent"
  | "UserInputRequestedEvent"
  | "ModelClientStreamingChunkEvent"
  | "SelectSpeakerEvent"
  | "CodeGenerationEvent"
  | "CodeExecutionEvent"
  | "StructuredMessage"
  | "SelectorEvent";

/** AutoGen v0.7 message shape */
export interface AutoGenMessage {
  /** v0.7: source (agent identity) replaces role */
  source: string;
  content: string | unknown[];
  /** v0.7 uses `type` discriminator (e.g., "TextMessage", "ToolCallRequestEvent") */
  type?: AutoGenMessageKind;
  /** @deprecated v0.2 compat — use source instead */
  role?: "user" | "assistant" | "system" | "tool";
  name?: string;
}

/** AutoGen v0.7 FunctionCall (flat format — NOT the OpenAI wrapper) */
export interface AutoGenFunctionCall {
  id: string;
  name: string;
  arguments: string;
}

/** @deprecated Use AutoGenFunctionCall — v0.2 used OpenAI wrapper format */
export interface AutoGenToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** AutoGen v0.4.8+ FunctionExecutionResult */
export interface AutoGenFunctionExecutionResult {
  call_id: string;
  /** Function name that produced this result (added v0.4.8) */
  name: string;
  content: string;
  /** Whether this result represents an error (None = unknown) */
  is_error?: boolean | null;
}

/** AutoGen v0.7 ToolCallRequestEvent */
export interface AutoGenToolCallRequest {
  source: string;
  /** v0.7: content is a list of FunctionCall objects */
  content: AutoGenFunctionCall[];
}

/** AutoGen v0.7 ToolCallExecutionEvent */
export interface AutoGenToolCallExecution {
  source: string;
  /** v0.7: content is a list of FunctionExecutionResult objects */
  content: AutoGenFunctionExecutionResult[];
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernAutoGenConfig {
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

export interface GovernedAutoGenAgentResult {
  agent: AutoGenAgent;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

export interface GovernedAutoGenToolsResult {
  tools: AutoGenTool[];
  agentId: string;
  score: number;
  level: number;
}
