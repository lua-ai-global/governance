/**
 * Types for the Anthropic Claude SDK governance integration.
 *
 * Mirrors @anthropic-ai/sdk v0.78+ shapes without requiring the SDK
 * as a dependency. Structurally compatible at runtime.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Anthropic SDK Shapes ───────────────────────────────────

/** Anthropic cache control */
export interface AnthropicCacheControl {
  type: "ephemeral";
  /** Cache TTL — "5m" (default) or "1h" (2x write cost) */
  ttl?: "5m" | "1h";
}

/** Anthropic tool input schema */
export interface AnthropicInputSchema {
  type: "object";
  properties?: unknown;
  required?: string[];
  [k: string]: unknown;
}

/** Anthropic tool definition (matches SDK Tool type) */
export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema: AnthropicInputSchema;
  cache_control?: AnthropicCacheControl | null;
  type?: "custom" | null;
  /** Which callers may invoke this tool (programmatic tool calling) */
  allowed_callers?: Array<"direct" | "code_execution_20250825" | "code_execution_20260120">;
  /** Defer loading — tool not included in initial system prompt */
  defer_loading?: boolean;
  /** Enable eager input streaming for tool parameters */
  eager_input_streaming?: boolean | null;
  /** Example inputs for the tool */
  input_examples?: Array<Record<string, unknown>>;
  /** Enable strict schema validation (structured outputs) */
  strict?: boolean;
}

/** Anthropic tool caller (identifies who initiated the tool_use) */
export type AnthropicToolCaller =
  | { type: "direct" }
  | { type: "code_execution_20250825"; tool_id: string }
  | { type: "code_execution_20260120"; tool_id: string };

/** Anthropic tool_use content block (from assistant response) */
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  /** Which caller initiated this tool use (always present in SDK response blocks) */
  caller: AnthropicToolCaller;
}

/** Anthropic tool_result content block (sent back by user) */
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlockParam[];
  is_error?: boolean;
  cache_control?: AnthropicCacheControl | null;
}

/** Anthropic content block param (for tool_result content) */
export type AnthropicContentBlockParam =
  | { type: "text"; text: string }
  | { type: "image"; source: Record<string, unknown> }
  | { type: "document"; source: Record<string, unknown> }
  | { type: "tool_reference"; tool_name: string; cache_control?: AnthropicCacheControl | null }
  | { type: "search_result"; content: unknown; source: string; title: string; cache_control?: AnthropicCacheControl | null; citations?: unknown };

/** Anthropic response content block union */
export type AnthropicContentBlock =
  | { type: "text"; text: string; citations?: unknown[] }
  | AnthropicToolUseBlock
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "server_tool_use"; id: string; name: "web_search" | "web_fetch" | "code_execution" | "bash_code_execution" | "text_editor_code_execution" | "tool_search_tool_regex" | "tool_search_tool_bm25"; input: unknown; caller: AnthropicToolCaller }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown; caller: AnthropicToolCaller }
  | { type: "web_fetch_tool_result"; tool_use_id: string; content: unknown; caller: AnthropicToolCaller }
  | { type: "code_execution_tool_result"; tool_use_id: string; content: { type: "code_execution_result"; stdout: string; stderr: string; return_code: number; content: unknown[] } | { type: "code_execution_tool_result_error"; error_code: string } | { type: "encrypted_code_execution_result"; encrypted_stdout: string; return_code: number; stderr: string; content: unknown[] } }
  | { type: "bash_code_execution_tool_result"; tool_use_id: string; content: unknown }
  | { type: "text_editor_code_execution_tool_result"; tool_use_id: string; content: unknown }
  | { type: "tool_search_tool_result"; tool_use_id: string; content: unknown }
  | { type: "container_upload"; file_id: string };

/** Anthropic tool executor — maps tool names to handlers */
export interface AnthropicToolExecutor {
  name: string;
  description?: string;
  inputSchema: AnthropicInputSchema | Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string | AnthropicContentBlockParam[]>;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernAnthropicConfig {
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
  onWarn?: (decision: EnforcementDecision, toolName: string) => void;
  onMask?: (decision: EnforcementDecision, toolName: string, maskedText: string) => void;
  onApprovalRequired?: (decision: EnforcementDecision, toolName: string) => void;
  actionMapper?: (toolName: string) => PolicyAction;
  sessionTokenTracker?: () => number;
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedAnthropicResult {
  tools: AnthropicToolExecutor[];
  /** Process a tool_use block: enforce policy, execute, return tool_result */
  handleToolUse: (block: AnthropicToolUseBlock) => Promise<AnthropicToolResultBlock>;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}
