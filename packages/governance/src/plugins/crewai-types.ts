/**
 * Types for the CrewAI governance integration.
 *
 * NOTE: CrewAI is Python-first with no official TypeScript SDK.
 * These types approximate CrewAI Python shapes for governance
 * wrapping purposes. The Python SDK uses `_run()` / `_arun()`
 * methods, not `execute()`.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentFramework } from "../types";

// ─── CrewAI Shapes ──────────────────────────────────────────

/** CrewAI tool shape */
export interface CrewAITool {
  name: string;
  description: string;
  /** Pydantic model schema for tool input validation */
  argsSchema?: Record<string, unknown>;
  /** Whether result should be used as final answer */
  resultAsAnswer?: boolean;
  /** Maximum number of times this tool can be used per task */
  maxUsageCount?: number;
  /** Custom caching logic */
  cacheFunction?: (args: Record<string, unknown>, result: unknown) => boolean;
  /**
   * Execute the tool — governance wrapper method.
   * Maps to Python `_run()` / `_arun()` methods.
   */
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

/** CrewAI agent shape */
export interface CrewAIAgent {
  role: string;
  goal: string;
  backstory: string;
  tools?: CrewAITool[];
  allowDelegation?: boolean;
  /** Language model configuration */
  llm?: string | Record<string, unknown>;
  /** Language model for tool calling; overrides crew's LLM */
  functionCallingLlm?: string | Record<string, unknown>;
  /** Agent memory configuration (accepts Memory objects in Python SDK) */
  memory?: boolean | unknown;
  /** Maximum iterations before stopping (default: 25) */
  maxIter?: number;
  /** Maximum requests per minute to avoid rate limits */
  maxRpm?: number;
  /** Maximum execution time in seconds */
  maxExecutionTime?: number;
  /** Maximum retry attempts (default: 2) */
  maxRetryLimit?: number;
  /** Whether code execution is allowed — SECURITY CRITICAL */
  allowCodeExecution?: boolean;
  /** Code execution safety mode — SECURITY CRITICAL */
  codeExecutionMode?: "safe" | "unsafe";
  /** Step callback for per-step hooks */
  stepCallback?: (step: unknown) => void;
  /** Whether to enable verbose logging */
  verbose?: boolean;
  /** Enable caching for tool usage (default: true) */
  cache?: boolean;
  /** Custom system prompt template */
  systemTemplate?: string;
  /** Custom prompt template for input */
  promptTemplate?: string;
  /** Custom response template for output */
  responseTemplate?: string;
  /** Keep messages under context window size by summarizing (default: true) */
  respectContextWindow?: boolean;
  /** Support for multimodal capabilities */
  multimodal?: boolean;
  /** Whether to use system prompt — needed for o1 model support (default: true) */
  useSystemPrompt?: boolean;
  /** Whether agent should reflect and plan before executing */
  reasoning?: boolean;
  /** Maximum reasoning attempts before task execution */
  maxReasoningAttempts?: number;
  /** Configuration for embedder used by agent */
  embedder?: Record<string, unknown>;
  /** Knowledge sources available to agent */
  knowledgeSources?: unknown[];
  /** Automatically inject current date into tasks */
  injectDate?: boolean;
  /** Format string for injected dates (default: "%Y-%m-%d") */
  dateFormat?: string;
}

/** CrewAI task shape */
export interface CrewAITask {
  description: string;
  agent?: CrewAIAgent;
  tools?: CrewAITool[];
  expectedOutput: string;
  /** Task identifier label */
  name?: string;
  /** Task dependencies — other tasks whose outputs become context */
  context?: CrewAITask[];
  /** Whether this task requires human input */
  humanInput?: boolean;
  /** Run task asynchronously */
  asyncExecution?: boolean;
  /** Callback on task completion */
  callback?: (output: unknown) => void;
  /** Pydantic model for structured JSON output */
  outputJson?: Record<string, unknown>;
  /** Pydantic model for structured pydantic output */
  outputPydantic?: Record<string, unknown>;
  /** File path for storing task output */
  outputFile?: string;
  /** Whether to create directory for output_file if absent (default: true) */
  createDirectory?: boolean;
  /** Whether to format final answer in Markdown */
  markdown?: boolean;
  /** Task-specific configuration parameters */
  config?: Record<string, unknown>;
  /** Function to validate task output before proceeding */
  guardrail?: (output: unknown) => unknown;
  /** List of guardrail functions to validate task output */
  guardrails?: Array<(output: unknown) => unknown>;
  /** Maximum retry attempts when guardrail validation fails (default: 3) */
  guardrailMaxRetries?: number;
}

// ─── Configuration ──────────────────────────────────────────

export interface GovernCrewAIConfig {
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

export interface GovernedCrewAIAgentResult {
  agent: CrewAIAgent;
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
  enforce: (toolName: string, input?: Record<string, unknown>) => Promise<EnforcementDecision>;
  audit: (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>) => Promise<AuditEvent>;
}

export interface GovernedCrewAIToolsResult {
  tools: CrewAITool[];
  agentId: string;
  score: number;
  level: number;
}
