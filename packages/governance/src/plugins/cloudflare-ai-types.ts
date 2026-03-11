/**
 * Types for the Cloudflare Workers AI governance integration.
 *
 * Mirrors Cloudflare AI Gateway and Workers AI shapes targeting the
 * OpenAI-compatible endpoint (/v1/chat/completions). The native
 * AI.run() API uses a flatter format — these types target the
 * OpenAI-compat interface which is more widely adopted.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Cloudflare Workers AI Shapes ───────────────────────────

/** Cloudflare AI tool call shape */
export interface CloudflareToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Cloudflare AI tool definition */
export interface CloudflareToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}

/** Cloudflare AI message */
export interface CloudflareMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: CloudflareToolCallMessage[];
  tool_call_id?: string;
}

/** Cloudflare tool call in assistant message */
export interface CloudflareToolCallMessage {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Cloudflare AI Gateway request */
export interface CloudflareAIGatewayRequest {
  model: string;
  messages: CloudflareMessage[];
  tools?: CloudflareToolDefinition[];
  /** Controls tool invocation: "auto" (default), "required" (force tool use), "none" (disable) */
  tool_choice?: "auto" | "required" | "none";
  stream?: boolean;
}

/** Cloudflare AI tool executor */
export interface CloudflareToolExecutor {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernCloudflareAIConfig {
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

export interface GovernedCloudflareAIResult {
  tools: CloudflareToolExecutor[];
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}
