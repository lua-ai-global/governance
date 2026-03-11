/**
 * Types for the E2B sandbox governance integration.
 *
 * Mirrors e2b v1.x / @e2b/code-interpreter v1.5+ shapes without
 * requiring the SDK as a dependency. Structurally compatible at runtime.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── E2B Shapes ─────────────────────────────────────────────

/** E2B OutputMessage from code interpreter kernel */
export interface E2BOutputMessage {
  line: string;
  timestamp: number;
  error: boolean;
}

/** E2B code execution request (matches @e2b/code-interpreter RunCodeOpts) */
export interface E2BCodeExecution {
  code: string;
  /** Language for the code interpreter kernel (defaults to "python") */
  language?: string;
  /** Code execution timeout in milliseconds (default: 60,000) */
  timeoutMs?: number;
  /** API request timeout in milliseconds (default: 30,000) */
  requestTimeoutMs?: number;
  envs?: Record<string, string>;
  /** Callback for stdout output */
  onStdout?: (output: E2BOutputMessage) => void | Promise<void>;
  /** Callback for stderr output */
  onStderr?: (output: E2BOutputMessage) => void | Promise<void>;
  /** Callback for execution result data */
  onResult?: (data: E2BResult) => void | Promise<void>;
  /** Callback for execution error */
  onError?: (error: E2BError) => void | Promise<void>;
}

/** E2B execution result (mirrors SDK Execution class) */
export interface E2BExecutionResult {
  text?: string;
  results: E2BResult[];
  error?: E2BError;
  logs: { stdout: string[]; stderr: string[] };
  /** Execution count from the kernel */
  executionCount?: number;
}

/** E2B individual result (mirrors SDK Result class) */
export interface E2BResult {
  text?: string;
  html?: string;
  markdown?: string;
  svg?: string;
  png?: string;
  jpeg?: string;
  pdf?: string;
  latex?: string;
  json?: string;
  javascript?: string;
  data?: Record<string, unknown>;
  chart?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  raw: Record<string, unknown>;
  isMainResult: boolean;
}

/** E2B error */
export interface E2BError {
  name: string;
  value: string;
  traceback: string;
}

/** E2B filesystem operation (matches Sandbox.files methods) */
export interface E2BFilesystemOp {
  operation: "read" | "write" | "list" | "remove" | "exists" | "makeDir" | "rename" | "watchDir" | "getInfo";
  path: string;
  content?: string | ArrayBuffer | Blob | ReadableStream;
  /** Destination path for rename operations */
  destPath?: string;
  /** Read format */
  format?: "text" | "bytes" | "blob" | "stream";
  /** Request timeout in milliseconds (default: 30,000) */
  requestTimeoutMs?: number;
}

/** E2B command execution (matches Sandbox.commands.run / commands.start) */
export interface E2BCommandExecution {
  command: string;
  cwd?: string;
  envs?: Record<string, string>;
  /** Command timeout in milliseconds (default: 60,000) */
  timeoutMs?: number;
  /** API request timeout in milliseconds (default: 30,000) */
  requestTimeoutMs?: number;
  /** Run command in background */
  background?: boolean;
  /** User to run as (default: "user") */
  user?: string;
  /** Callback for stdout */
  onStdout?: (data: string) => void | Promise<void>;
  /** Callback for stderr */
  onStderr?: (data: string) => void | Promise<void>;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernE2BConfig {
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
  actionMapper?: (context: string) => PolicyAction;
  sessionTokenTracker?: () => number;
  /** Blocked code patterns (regex strings) */
  blockedPatterns?: string[];
}

// ─── Results ────────────────────────────────────────────────

export interface GovernedE2BResult {
  /** Governed code execution */
  executeCode: (execution: E2BCodeExecution) => Promise<E2BExecutionResult>;
  /** Governed filesystem access */
  filesystem: (op: E2BFilesystemOp) => Promise<unknown>;
  /** Governed command execution */
  spawn: (cmd: E2BCommandExecution) => Promise<unknown>;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (context: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (context: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

/** Handler for E2B code execution */
export type E2BCodeHandler = (execution: E2BCodeExecution) => Promise<E2BExecutionResult>;

/** Handler for E2B filesystem ops */
export type E2BFilesystemHandler = (op: E2BFilesystemOp) => Promise<unknown>;

/** Handler for E2B command execution */
export type E2BCommandHandler = (cmd: E2BCommandExecution) => Promise<unknown>;
