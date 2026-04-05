/**
 * Types for the Mistral AI governance integration.
 *
 * Mirrors @mistralai/mistralai (client-ts) shapes without requiring the SDK
 * as a dependency. Structurally compatible at runtime.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Mistral AI Shapes ──────────────────────────────────────

/** Mistral tool definition */
export interface MistralToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    /** Enforce strict JSON schema for parameters */
    strict?: boolean;
  };
}

/** Mistral tool call from assistant response */
export interface MistralToolCall {
  /** Tool call ID (SDK defaults to "null" if absent) */
  id?: string;
  type?: "function";
  function: {
    name: string;
    /** Arguments — JSON string in API responses, may be pre-parsed in SDK */
    arguments: string | Record<string, unknown>;
  };
  /** Position in parallel tool calls (SDK defaults to 0) */
  index?: number;
}

/** Mistral tool executor */
export interface MistralToolExecutor {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernMistralConfig {
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

export interface GovernedMistralResult {
  tools: MistralToolExecutor[];
  /** Process a Mistral tool call: enforce policy, execute, return result */
  handleToolCall: (toolCall: MistralToolCall) => Promise<{ toolCallId: string; content: string }>;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}
