/**
 * Types for the AWS Bedrock governance integration.
 *
 * Covers both Bedrock Agent Runtime (@aws-sdk/client-bedrock-agent-runtime)
 * and Bedrock Runtime Converse API (@aws-sdk/client-bedrock-runtime).
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Bedrock Agent Runtime Shapes ──────────────────────────

/** Bedrock InvokeAgent input */
export interface BedrockInvokeAgentInput {
  agentId: string;
  agentAliasId: string;
  sessionId: string;
  inputText?: string;
  enableTrace?: boolean;
  endSession?: boolean;
  memoryId?: string;
  streamingConfigurations?: Record<string, unknown>;
  bedrockModelConfigurations?: Record<string, unknown>;
  sourceArn?: string;
  sessionState?: Record<string, unknown>;
  promptCreationConfigurations?: Record<string, unknown>;
}

/** Bedrock action group invocation */
export interface BedrockActionGroupInvocation {
  actionGroupName: string;
  apiPath?: string;
  verb?: string;
  parameters?: BedrockActionParameter[];
  requestBody?: Record<string, unknown>;
  executionType?: string;
  invocationId?: string;
  function?: { name: string; parameters?: Record<string, unknown> };
}

/** Bedrock action parameter */
export interface BedrockActionParameter {
  name: string;
  type?: string;
  value: string;
}

/** Bedrock InvokeAgent response chunk */
export interface BedrockResponseChunk {
  bytes?: Uint8Array;
  attribution?: Record<string, unknown>;
}

/** Bedrock trace for observability */
export interface BedrockTrace {
  orchestrationTrace?: {
    modelInvocationInput?: Record<string, unknown>;
    modelInvocationOutput?: Record<string, unknown>;
    rationale?: { text?: string };
    observation?: Record<string, unknown>;
    invocationInput?: {
      actionGroupInvocationInput?: BedrockActionGroupInvocation;
    };
  };
  preProcessingTrace?: Record<string, unknown>;
  postProcessingTrace?: Record<string, unknown>;
  failureTrace?: { failureReason?: string };
  guardrailTrace?: Record<string, unknown>;
  customOrchestrationTrace?: Record<string, unknown>;
  routingClassifierTrace?: Record<string, unknown>;
}

// ─── Bedrock Converse API Shapes ───────────────────────────

/** Tool use block from Converse API response */
export interface BedrockToolUseBlock {
  toolUseId: string;
  name: string;
  input: unknown;
  /** Tool use type (e.g., "server_tool_use" for server-side tools) */
  type?: string;
}

/** Tool result block for Converse API request */
export interface BedrockToolResultBlock {
  toolUseId: string;
  content: BedrockToolResultContent[];
  status?: "success" | "error";
  /** Content block type identifier (optional) */
  type?: string;
}

/** Tool result content */
export type BedrockToolResultContent =
  | { text: string }
  | { json: Record<string, unknown> }
  | { image: { format: string; source: { bytes: Uint8Array } } }
  | { document: { format: string; name: string; source: { bytes: Uint8Array } } }
  | { video: { format: string; source: { bytes: Uint8Array } } }
  | { searchResult: Record<string, unknown> };

/** Converse API content block union */
export type BedrockContentBlock =
  | { text: string }
  | { image: { format: string; source: { bytes: Uint8Array } } }
  | { document: { format: string; name: string; source: { bytes: Uint8Array } } }
  | { audio: { format: string; source: { bytes: Uint8Array } } }
  | { video: { format: string; source: { bytes: Uint8Array } } }
  | { toolUse: BedrockToolUseBlock }
  | { toolResult: BedrockToolResultBlock }
  | { guardContent: Record<string, unknown> }
  | { cachePoint: { type: "default"; ttl?: "5m" | "1h" } }
  | { reasoningContent: { reasoningText?: { text: string; signature?: string }; redactedContent?: Uint8Array } }
  | { citationsContent: Record<string, unknown> }
  | { searchResult: Record<string, unknown> };

/** Converse tool spec */
export interface BedrockToolSpec {
  name: string;
  description?: string;
  inputSchema: { json: Record<string, unknown> };
  /** Enforce strict JSON schema for tool output */
  strict?: boolean;
}

/** Converse tool definition */
export type BedrockTool =
  | { toolSpec: BedrockToolSpec }
  | { cachePoint: { type: "default"; ttl?: "5m" | "1h" } }
  | { systemTool: { name: string } };

/** Converse tool choice */
export type BedrockToolChoice =
  | { auto: Record<string, never> }
  | { any: Record<string, never> }
  | { tool: { name: string } };

/** Converse tool configuration */
export interface BedrockToolConfiguration {
  tools: BedrockTool[];
  toolChoice?: BedrockToolChoice;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernBedrockConfig {
  agentName: string;
  owner: string;
  framework?: AgentFramework;
  description?: string;
  version?: string;
  channels?: string[];
  tools?: string[];
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
   * Pre-scan the user inputText before invokeAgent runs (default: true).
   * Entry-gate only — Bedrock Agents execute internal tool calls server-side
   * inside AWS, so we can't see individual tool calls. We CAN gate the prompt
   * going in and the final response text coming out.
   */
  preprocess?: boolean;
  /** Post-scan tag — consumed by the scanOutput helper (default: true). */
  postprocess?: boolean;
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedBedrockResult {
  /** Governed invokeAgent wrapper */
  invokeAgent: (input: BedrockInvokeAgentInput) => Promise<unknown>;
  /** Governed action group execution guard */
  guardActionGroup: (invocation: BedrockActionGroupInvocation) => Promise<EnforcementDecision>;
  /** Guard a tool_use block from Converse API response */
  guardToolUse: (block: BedrockToolUseBlock) => Promise<EnforcementDecision>;
  /**
   * Post-scan assembled Bedrock response text. Use after your own code has
   * drained invokeAgent's streamed chunks and assembled them into text.
   * Returns the (possibly masked) text; throws GovernanceBlockedError on block.
   */
  scanOutput: (outputText: string) => Promise<string>;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

/** Handler for Bedrock agent invocations */
export type BedrockInvokeHandler = (input: BedrockInvokeAgentInput) => Promise<unknown>;
