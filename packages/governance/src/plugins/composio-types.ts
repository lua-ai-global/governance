/**
 * Types for the Composio governance integration.
 *
 * Mirrors @composio/core v0.6+ shapes without requiring the SDK
 * as a dependency. Structurally compatible at runtime.
 *
 * NOTE: Composio SDK migrated from composio-core to @composio/core.
 * "Actions" are now "Tools", "Apps" are now "Toolkits",
 * "Integrations" are now "Auth Configs", "Connections" are now
 * "Connected Accounts", "Entity ID" is now "User ID".
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Composio Shapes (@composio/core v0.6+) ────────────────

/** Composio tool (formerly "action") — v3 uses session-based execution */
export interface ComposioTool {
  /** Tool slug identifier (e.g. "GITHUB_CREATE_ISSUE") */
  name: string;
  description?: string;
  /** Toolkit slug (formerly "appName") */
  toolkitSlug?: string;
  parameters?: Record<string, unknown>;
  /** Tool version — e.g. "20250909_00" or "latest". SDK field name is `version`, not `toolkitVersion`. */
  version?: string;
  /**
   * v3 tools are executed via session.tools() + execute pattern,
   * not via composio.tools.execute() (deprecated). This field supports wrapper patterns.
   */
  execute?: (params: Record<string, unknown>) => Promise<ComposioToolResult>;
}

/** Composio tool execution result */
export interface ComposioToolResult {
  successful: boolean;
  data?: unknown;
  error?: string | null;
}

/** Composio connected account (formerly "connection") */
export interface ComposioConnectedAccount {
  /** User ID (formerly "entityId") */
  userId: string;
  /** Toolkit slug (formerly "appName") */
  toolkitSlug: string;
  connectedAccountId: string;
  status: "active" | "inactive" | "expired" | "initiated";
}

/** Composio trigger */
export interface ComposioTrigger {
  name: string;
  toolkitSlug: string;
  description?: string;
  config?: Record<string, unknown>;
}

// ─── Legacy Aliases (backward compat) ───────────────────────

/** @deprecated Use ComposioTool instead */
export type ComposioAction = ComposioTool;

/** @deprecated Use ComposioToolResult instead */
export type ComposioActionResult = ComposioToolResult;

/** @deprecated Use ComposioConnectedAccount instead */
export type ComposioConnection = ComposioConnectedAccount;

// ─── Configuration ──────────────────────────────────────────

export interface GovernComposioConfig {
  agentName: string;
  owner: string;
  /** User ID for Composio session (formerly "entityId") */
  userId?: string;
  /** Session ID for correlating meta tool calls */
  sessionId?: string;
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
  /** Map toolkit slugs to policy actions */
  toolkitActionMapper?: (toolkitSlug: string) => PolicyAction;
  /** @deprecated Use toolkitActionMapper instead */
  appActionMapper?: (appName: string) => PolicyAction;
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedComposioResult {
  /** Governed tools (formerly "actions") */
  tools: ComposioTool[];
  /** @deprecated Use tools instead */
  actions: ComposioTool[];
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}
