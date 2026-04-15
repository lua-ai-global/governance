/**
 * Types for the MCP (Model Context Protocol) governance integration.
 *
 * Mirrors MCP spec 2025-11-25 / @modelcontextprotocol/sdk v1.27+
 * shapes without requiring the SDK as a dependency.
 *
 * NOTE: Tasks (long-running tool calls), Elicitation, and Extensions
 * from spec 2025-11-25 are not modeled here as they don't affect
 * tool governance enforcement.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── MCP SDK Shapes (spec 2025-11-25) ──────────────────────

/** MCP content annotations */
export interface MCPAnnotations {
  audience?: ("user" | "assistant")[];
  priority?: number;
  lastModified?: string;
}

/** MCP tool call request */
export interface MCPCallToolRequest {
  method: "tools/call";
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

/** MCP tool call result */
export interface MCPCallToolResult {
  content: MCPContent[];
  /** Structured content (spec 2025-06-18) */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** Protocol-level metadata */
  _meta?: Record<string, unknown>;
}

/** MCP content block (spec 2025-06-18 — includes audio and resource_link) */
export type MCPContent =
  | MCPTextContent
  | MCPImageContent
  | MCPAudioContent
  | MCPResourceContent
  | MCPResourceLinkContent;

/** MCP text content */
export interface MCPTextContent {
  type: "text";
  text: string;
  annotations?: MCPAnnotations;
  _meta?: Record<string, unknown>;
}

/** MCP image content */
export interface MCPImageContent {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: MCPAnnotations;
  _meta?: Record<string, unknown>;
}

/** MCP audio content (spec 2025-06-18) */
export interface MCPAudioContent {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: MCPAnnotations;
  _meta?: Record<string, unknown>;
}

/** MCP embedded resource content */
export interface MCPResourceContent {
  type: "resource";
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
  annotations?: MCPAnnotations;
  _meta?: Record<string, unknown>;
}

/** MCP resource link content (spec 2025-11-25) */
export interface MCPResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  annotations?: MCPAnnotations;
  title?: string;
  /** Resource link icons (spec 2025-11-25) */
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
  _meta?: Record<string, unknown>;
}

/** MCP resource read request */
export interface MCPReadResourceRequest {
  method: "resources/read";
  params: {
    uri: string;
  };
}

/** MCP tool definition (spec 2025-06-18) */
export interface MCPToolDefinition {
  name: string;
  /** Human-readable display name */
  title?: string;
  description?: string;
  /** Input JSON Schema (required — must have type: "object") */
  inputSchema: Record<string, unknown>;
  /** Output schema for structured results (spec 2025-06-18) */
  outputSchema?: Record<string, unknown>;
  /** Tool behavior annotations */
  annotations?: MCPToolAnnotations;
  /** Task support for long-running tool calls (spec 2025-11-25) */
  execution?: { taskSupport?: "forbidden" | "optional" | "required" };
  /** Tool icons (spec 2025-11-25) */
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
  /** Protocol-level metadata */
  _meta?: Record<string, unknown>;
}

/** MCP tool annotations (spec 2025-11-25) */
export interface MCPToolAnnotations {
  /** Human-readable title for the tool annotation */
  title?: string;
  /** Whether this tool is read-only (default: false) */
  readOnlyHint?: boolean;
  /** Whether this tool is destructive (default: true when readOnlyHint=false) */
  destructiveHint?: boolean;
  /** Whether this tool is idempotent (default: false) */
  idempotentHint?: boolean;
  /** Whether this tool interacts with untrusted external systems (default: true) */
  openWorldHint?: boolean;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernMCPConfig {
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
  /** Map resource URIs to policy actions (default: data_access) */
  resourceActionMapper?: (uri: string) => PolicyAction;
  /** Whether to govern resource reads (default: true) */
  governResources?: boolean;
  /** Whether to scan tool output text for injection patterns (default: true) */
  scanToolOutputs?: boolean;
  /** Injection detection threshold for tool outputs (default: 0.6) */
  outputInjectionThreshold?: number;
  /** Whether to scan tool INPUT text for injection patterns (default: true) */
  scanToolInputs?: boolean;
  /** Injection detection threshold for tool inputs (default: 0.6) */
  inputInjectionThreshold?: number;
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedMCPResult {
  /** Governed tool call handler — use as your server's tools/call handler */
  handleToolCall: (request: MCPCallToolRequest) => Promise<MCPCallToolResult>;
  /** Governed resource read handler — use as your server's resources/read handler */
  handleResourceRead: (request: MCPReadResourceRequest) => Promise<MCPContent[]>;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

/** Handler function for MCP tool calls */
export type MCPToolCallHandler = (
  request: MCPCallToolRequest,
) => Promise<MCPCallToolResult>;

/** Handler function for MCP resource reads */
export type MCPResourceReadHandler = (
  request: MCPReadResourceRequest,
) => Promise<MCPContent[]>;
