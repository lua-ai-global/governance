/**
 * Types for the OpenAI Agents SDK governance integration.
 *
 * Mirrors @openai/agents-core v0.6.0 FunctionTool shape without
 * requiring the SDK as a dependency. Structurally compatible at runtime.
 *
 * v0.6.0 (March 2026): tool search support GA, computer use GA.
 * SDK uses `invoke`, `parameters`, `strict` (required in SDK,
 * optional here for governance wrapper flexibility).
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── OpenAI Agents SDK Shapes ───────────────────────────────

/** Run context passed to tool invocations */
export interface OpenAIRunContext {
  usage?: Record<string, unknown>;
  /** User-provided context (generic TContext in SDK) */
  context?: unknown;
  /** Structured input for the current agent tool run, when available */
  toolInput?: unknown;
  [key: string]: unknown;
}

/** Tool call details passed as third argument to invoke (SDK: ToolCallDetails) */
export interface OpenAIToolCallDetails {
  /** The original function call item (protocol.FunctionCallItem in SDK) */
  toolCall?: Record<string, unknown>;
  /** Resume state for continuations */
  resumeState?: string;
  signal?: AbortSignal;
  /** Parent run configuration (Partial<RunConfig> in SDK) */
  parentRunConfig?: Record<string, unknown>;
}

/**
 * OpenAI Agents SDK function tool shape (matches @openai/agents-core FunctionTool v0.6.0).
 *
 * In the SDK, `parameters`, `strict`, `needsApproval`, and `isEnabled` are required.
 * They are optional here for governance wrapper flexibility — we wrap tools that
 * already exist rather than constructing new ones.
 */
export interface OpenAIFunctionTool {
  type: "function";
  name: string;
  description: string;
  /** JSON Schema for tool parameters (required in SDK, optional here for wrapper flexibility) */
  parameters?: Record<string, unknown>;
  /** Whether schema validation is strict (required in SDK, optional here for wrapper flexibility) */
  strict?: boolean;
  /** Tool invocation handler — receives RunContext, JSON string args, optional details */
  invoke?: (ctx: OpenAIRunContext, args: string, details?: OpenAIToolCallDetails) => Promise<string | unknown>;
  /** Whether this tool is currently enabled (required in SDK as ToolEnabledFunction) */
  isEnabled?: (ctx: OpenAIRunContext, agent?: OpenAIAgent) => boolean | Promise<boolean>;
  /** Defer loading the tool definition */
  deferLoading?: boolean;
  /** Human-in-the-loop approval function (required in SDK as ToolApprovalFunction) */
  needsApproval?: (ctx: OpenAIRunContext, input: unknown, callId?: string) => boolean | Promise<boolean>;
  /** Per-tool timeout in milliseconds */
  timeoutMs?: number;
  /** Behavior on timeout */
  timeoutBehavior?: "error_as_result" | "raise_exception";
  /** Custom error message function for timeouts — receives ToolTimeoutError (Error subclass) */
  timeoutErrorFunction?: (ctx: OpenAIRunContext, error: Error) => string | Promise<string>;
  /** SDK-native input guardrails */
  inputGuardrails?: unknown[];
  /** SDK-native output guardrails */
  outputGuardrails?: unknown[];
  /** @deprecated Governance wrapper legacy — does not exist in SDK. Use invoke instead. */
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
}

/** OpenAI Agents SDK agent shape (matches @openai/agents Agent) */
export interface OpenAIAgent {
  name: string;
  instructions?: string | ((runContext: OpenAIRunContext, agent: OpenAIAgent) => string | Promise<string>);
  tools?: OpenAIFunctionTool[];
  /** Model name string or Model instance */
  model?: string | unknown;
  handoffs?: unknown[];
  /** Model configuration settings */
  modelSettings?: Record<string, unknown>;
  /** Output type schema */
  outputType?: Record<string, unknown>;
  /** Description for handoff */
  handoffDescription?: string;
  /** Responses API prompt template */
  prompt?: unknown;
  /** MCP servers for this agent */
  mcpServers?: unknown[];
  /** Agent-level input guardrails */
  inputGuardrails?: unknown[];
  /** Agent-level output guardrails */
  outputGuardrails?: unknown[];
  /** Controls behavior after tool calls */
  toolUseBehavior?: "run_llm_again" | "stop_on_first_tool" | { stopAtToolNames: string[] } | ((context: unknown, toolResults: unknown[]) => unknown | Promise<unknown>);
  /** Whether to reset tool choice after each turn */
  resetToolChoice?: boolean;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernAgentConfig {
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
  /**
   * Master switch for tool-result scanning (governance-sdk 0.15+).
   * Default: `true`. Wrapped tools run their return values through the
   * policy engine at stage `tool_result` before returning to the agent
   * loop. On block, the redacted detail object replaces the original.
   */
  scanToolResults?: boolean;
  /** Detection threshold for the local injection signal (0-1). Default 0.5. */
  toolResultInjectionThreshold?: number;
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedAgentResult<T extends OpenAIAgent> {
  agent: T;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

export interface GovernedToolsResult {
  tools: OpenAIFunctionTool[];
  agentId: string;
  score: number;
  level: number;
}
