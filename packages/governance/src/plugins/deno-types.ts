/**
 * Types for the Deno AI governance integration.
 *
 * Mirrors Deno-native AI agent patterns and permission system
 * without requiring Deno APIs as a dependency.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Deno AI Shapes ─────────────────────────────────────────

/** Deno AI tool shape */
export interface DenoTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Deno permission descriptor */
export interface DenoPermissionDescriptor {
  name: "read" | "write" | "net" | "env" | "run" | "ffi" | "sys" | "import";
  path?: string | URL;
  host?: string;
  command?: string | URL;
  variable?: string;
  /** Scope for sys permission */
  kind?: "loadavg" | "hostname" | "systemMemoryInfo" | "networkInterfaces" | "osRelease" | "osUptime" | "uid" | "gid" | "username" | "cpus" | "homedir" | "statfs" | "getPriority" | "setPriority";
}

/** Deno AI agent shape */
export interface DenoAgent {
  name: string;
  description?: string;
  tools: DenoTool[];
  permissions?: DenoPermissionDescriptor[];
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernDenoConfig {
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
  /** Map Deno permissions to policy actions */
  permissionMapper?: (perm: DenoPermissionDescriptor) => PolicyAction;
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedDenoAgentResult {
  agent: DenoAgent;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

export interface GovernedDenoToolsResult {
  tools: DenoTool[];
  agentId: string;
  score: number;
  level: number;
}
