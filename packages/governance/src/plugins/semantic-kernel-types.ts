/**
 * Types for the Microsoft Semantic Kernel governance integration.
 *
 * NOTE: As of March 2026, there is NO official @microsoft/semantic-kernel
 * npm package. A community package @semantic-kernel-typescript/core exists.
 * These types mirror the C#/Python SDK shapes (KernelFunction, KernelPlugin)
 * for TypeScript governance wrapping purposes.
 *
 * Microsoft is merging AutoGen + Semantic Kernel into "Microsoft
 * Agent Framework" — watch for a unified TS SDK.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── Semantic Kernel Shapes ─────────────────────────────────

/** Semantic Kernel function shape */
export interface KernelFunction {
  name: string;
  pluginName?: string;
  description?: string;
  parameters?: KernelParameter[];
  /** Return parameter metadata (describes function output) */
  returnParameter?: { description?: string; type?: string; schema?: Record<string, unknown> };
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Semantic Kernel function parameter */
export interface KernelParameter {
  name: string;
  description?: string;
  type?: string;
  required?: boolean;
  defaultValue?: unknown;
  /** JSON Schema for parameter validation (schema_data in Python SDK) */
  schema?: Record<string, unknown>;
  /** Whether to include in function choices (defaults to true in Python SDK) */
  includeInFunctionChoices?: boolean;
}

/** Semantic Kernel plugin shape */
export interface KernelPlugin {
  name: string;
  description?: string;
  /** Functions keyed by name (dict in Python SDK, not array) */
  functions: Record<string, KernelFunction>;
}

/** Semantic Kernel function filter context */
export interface FunctionFilterContext {
  function: KernelFunction;
  arguments: Record<string, unknown>;
  result?: unknown;
  /** Reference to the Kernel instance (required in Python SDK FilterContextBase) */
  kernel: unknown;
  /** Whether the invocation is streaming (defaults to false in Python SDK) */
  isStreaming?: boolean;
}

/**
 * Semantic Kernel function invocation filter.
 *
 * Modern SDK uses single-method next-delegate pattern:
 * `onFunctionInvocation(context, next)` where calling `next(context)`
 * proceeds with execution.
 */
export interface FunctionFilter {
  onFunctionInvocation: (context: FunctionFilterContext, next: (ctx: FunctionFilterContext) => Promise<void>) => Promise<void>;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernSKConfig {
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

export interface GovernedSKResult {
  /** Governed functions with policy enforcement */
  functions: KernelFunction[];
  /** Function filter for Kernel-level integration */
  filter: FunctionFilter;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

export interface GovernedSKPluginResult {
  plugin: KernelPlugin;
  agentId: string;
  score: number;
  level: number;
}
