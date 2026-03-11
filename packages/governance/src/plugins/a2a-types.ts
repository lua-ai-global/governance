/**
 * Types for the A2A (Agent-to-Agent Protocol) governance integration.
 *
 * Mirrors A2A protocol v0.3.0 shapes without requiring the A2A SDK
 * as a dependency. Based on the official A2A specification.
 *
 * NOTE: A2A spec has moved to v1.0 (proto-first) which removes `kind`
 * discriminators, consolidates `url`/`protocolVersion` into
 * `supportedInterfaces`, and drops `preferredTransport`. These types
 * target v0.3.0 which is still widely deployed. v1.0 fields are added
 * as optional for forward compatibility.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── A2A Protocol Shapes (v0.2.6+) ─────────────────────────

/** A2A Agent Card — describes an agent's capabilities */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  capabilities: A2ACapabilities;
  skills: A2ASkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  provider?: { organization: string; url?: string };
  /** OpenAPI-style security schemes */
  securitySchemes?: Record<string, A2ASecurityScheme>;
  security?: Array<Record<string, string[]>>;
  /** Icon URL for the agent (v0.3.0) */
  iconUrl?: string;
  /** Link to agent documentation (v0.3.0) */
  documentationUrl?: string;
  /** Preferred transport mechanism (v0.3.0) */
  preferredTransport?: string;
  /** Alternative transport bindings (v0.3.0) */
  additionalInterfaces?: Array<{ type: string; url: string }>;
  /** Whether agent supports authenticated extended card (v0.3.0) */
  supportsAuthenticatedExtendedCard?: boolean;
  /** JWS card signatures (RFC 7515 — v1.0 proto uses protected/signature/header) */
  signatures?: Array<{ protected: string; signature: string; header?: Record<string, unknown> }>;
  /** v1.0: Transport interfaces (replaces url + protocolVersion + additionalInterfaces) */
  supportedInterfaces?: Array<{ url: string; protocolBinding: string; protocolVersion: string; tenant?: string }>;
}

/** A2A security scheme (OpenAPI-compatible) */
export interface A2ASecurityScheme {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect" | "mutualTLS";
  scheme?: string;
  bearerFormat?: string;
  in?: "header" | "query" | "cookie";
  name?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
}

/** A2A agent capabilities */
export interface A2ACapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
  /** Supported extensions (v1.0: structured AgentExtension objects) */
  extensions?: Array<{ uri: string; description?: string; required?: boolean; params?: Record<string, unknown> }>;
}

/** A2A skill definition */
export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  /** Per-skill security requirements (v1.0 — uses SecurityRequirement wrapper) */
  securityRequirements?: Array<{ schemes: Record<string, string[]> }>;
}

/** A2A Task — the core unit of work between agents */
export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  /** Conversation history (v0.3.0 uses 'history', not 'messages') */
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
  /** @deprecated Use contextId instead */
  sessionId?: string;
}

/** A2A Task status */
export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp: string;
}

/** A2A task state values (v0.2.6+) */
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required";

/** A2A Message */
export interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2APart[];
  taskId?: string;
  contextId?: string;
  referenceTaskIds?: string[];
  /** Extension URIs */
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

/** A2A content part (uses kind discriminator, not type) */
export type A2APart =
  | { kind: "text"; text: string; metadata?: Record<string, unknown> }
  | { kind: "file"; file: { name?: string; mimeType?: string; bytes?: string; uri?: string }; metadata?: Record<string, unknown> }
  | { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> };

/** A2A Artifact — output from task execution */
export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  /** Extension URIs */
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

/** A2A message/send request (v0.2.6+ message-centric model) */
export interface A2AMessageSendRequest {
  id: string;
  method: "message/send";
  params: A2AMessageSendParams;
}

/** A2A message/send parameters */
export interface A2AMessageSendParams {
  message: A2AMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    blocking?: boolean;
    historyLength?: number;
    pushNotification?: { url: string; token?: string };
  };
  metadata?: Record<string, unknown>;
}

/** @deprecated Use A2AMessageSendRequest — task-centric model is deprecated */
export interface A2ASendTaskRequest {
  id: string;
  params: {
    id: string;
    /** @deprecated Use contextId */
    sessionId?: string;
    contextId?: string;
    message: A2AMessage;
    acceptedOutputModes?: string[];
    pushNotification?: { url: string; token?: string };
    metadata?: Record<string, unknown>;
  };
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernA2AConfig {
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
  onBlocked?: (decision: EnforcementDecision, context: string) => void;
  onDecision?: (decision: EnforcementDecision, context: string) => void;
  actionMapper?: (taskId: string) => PolicyAction;
  sessionTokenTracker?: () => number;
  /** Map target agent URLs to policy actions */
  targetAgentMapper?: (agentUrl: string) => PolicyAction;
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedA2AResult {
  /** Governed message sender — intercepts outbound messages */
  sendMessage: (request: A2AMessageSendRequest, targetAgent: A2AAgentCard) => Promise<A2ATask>;
  /** Governed message receiver — intercepts inbound messages */
  receiveMessage: (request: A2AMessageSendRequest, fromAgent?: A2AAgentCard) => Promise<A2ATask>;
  /** @deprecated Use sendMessage */
  sendTask: (request: A2ASendTaskRequest, targetAgent: A2AAgentCard) => Promise<A2ATask>;
  /** @deprecated Use receiveMessage */
  receiveTask: (request: A2ASendTaskRequest, fromAgent?: A2AAgentCard) => Promise<A2ATask>;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (context: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (context: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

/** Handler for A2A message send */
export type A2AMessageSendHandler = (
  request: A2AMessageSendRequest,
  targetAgent: A2AAgentCard,
) => Promise<A2ATask>;

/** Handler for A2A message receive */
export type A2AMessageReceiveHandler = (
  request: A2AMessageSendRequest,
  fromAgent?: A2AAgentCard,
) => Promise<A2ATask>;

/** @deprecated Use A2AMessageSendHandler */
export type A2ATaskSendHandler = A2AMessageSendHandler;

/** @deprecated Use A2AMessageReceiveHandler */
export type A2ATaskReceiveHandler = A2AMessageReceiveHandler;
