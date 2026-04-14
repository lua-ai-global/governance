/**
 * governance-sdk LangChain Plugin
 *
 * Integrates governance enforcement into LangChain/LangGraph tool execution.
 * Wraps tools with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governTool, governTools } from 'governance-sdk/plugins/langchain';
 * import { DynamicStructuredTool } from 'langchain/tools';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec', 'database_drop'])],
 * });
 *
 * const searchTool = new DynamicStructuredTool({
 *   name: 'web_search',
 *   description: 'Search the web',
 *   schema: z.object({ query: z.string() }),
 *   func: async ({ query }) => '...',
 * });
 *
 * // Wrap a single tool
 * const governed = await governTool(gov, searchTool, {
 *   agentName: 'research-agent',
 *   owner: 'research-team',
 * });
 *
 * // Or wrap all tools at once
 * const governedTools = await governTools(gov, [searchTool, crmTool], {
 *   agentName: 'research-agent',
 *   owner: 'research-team',
 * });
 * ```
 */

import type {
  GovernanceInstance,
  AuditEvent,
} from "../index";
import type {
  EnforcementDecision,
  PolicyAction,
} from "../policy";
import type { AgentRegistration, AgentFramework } from "../types";
import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Types ──────────────────────────────────────────────────────

/** LangChain runnable config (RunnableConfig / ToolRunnableConfig) */
export interface LangChainRunnableConfig {
  tags?: string[];
  metadata?: Record<string, unknown>;
  callbacks?: unknown[];
  /** Configurable fields for the runnable */
  configurable?: Record<string, unknown>;
  /** Custom run name for tracing */
  runName?: string;
  /** Run ID for tracing */
  runId?: string;
  /** Max concurrent calls */
  maxConcurrency?: number;
  /** Recursion limit (default 25 in SDK) */
  recursionLimit?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Tool call context (ToolRunnableConfig extension) */
  toolCall?: Record<string, unknown>;
  /** Tool runtime context (ToolRunnableConfig extension) */
  context?: unknown;
  [key: string]: unknown;
}

/** Generic LangChain tool shape (no direct dependency) */
export interface LangChainTool {
  name: string;
  description: string;
  /** Input schema (Zod or JSON Schema) */
  schema?: unknown;
  /** Whether to return result directly to user */
  returnDirect?: boolean;
  /** Response format — SDK accepts arbitrary strings beyond the two known values */
  responseFormat?: "content" | "content_and_artifact" | string;
  /** Whether to show verbose parsing errors */
  verboseParsingErrors?: boolean;
  /** Default runnable config for this tool */
  defaultConfig?: LangChainRunnableConfig;
  /** Extra tool metadata */
  extras?: Record<string, unknown>;
  /** Tool metadata */
  metadata?: Record<string, unknown>;
  invoke: (input: unknown, config?: LangChainRunnableConfig) => Promise<unknown>;
}

export interface GovernToolConfig {
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

export interface GovernedResult {
  agentId: string;
  score: number;
  level: number;
  governance: GovernanceInstance;
}

// ─── Blocked Error ──────────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Helper ─────────────────────────────────────────────────────

async function registerAgent(
  governance: GovernanceInstance,
  config: GovernToolConfig,
  toolNames: string[],
) {
  const registration: AgentRegistration = {
    name: config.agentName,
    framework: config.framework ?? "langchain",
    owner: config.owner,
    description: config.description,
    version: config.version,
    channels: config.channels,
    tools: toolNames,
    hasAuth: config.hasAuth,
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: true,
    permissions: config.permissions,
    metadata: config.metadata,
  };
  return governance.register(registration);
}

function createEnforcer(
  governance: GovernanceInstance,
  agentId: string,
  agentLevel: number,
  config: GovernToolConfig,
) {
  return async (toolName: string, input?: unknown): Promise<EnforcementDecision> => {
    const action = config.actionMapper?.(toolName) ?? ("tool_call" as PolicyAction);

    const decision = await governance.enforce({
      agentId,
      agentName: config.agentName,
      agentLevel,
      action,
      tool: toolName,
      input: typeof input === "object" && input !== null
        ? input as Record<string, unknown>
        : undefined,
      sessionTokensUsed: config.sessionTokenTracker?.(),
    });

    handleOutcome(decision, toolName, config as OutcomeCallbacks);

    return decision;
  };
}

function createAuditor(governance: GovernanceInstance, agentId: string) {
  return async (
    toolName: string,
    outcome: "success" | "failure",
    detail?: Record<string, unknown>,
  ): Promise<AuditEvent> => {
    return governance.audit.log({
      agentId,
      eventType: "tool_call",
      outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: { tool: toolName, ...detail },
    });
  };
}

// ─── Govern a Single Tool ───────────────────────────────────────

/**
 * Wrap a single LangChain tool with governance enforcement.
 *
 * Returns a new tool-like object with the same interface but governed invoke.
 */
export async function governTool<T extends LangChainTool>(
  governance: GovernanceInstance,
  tool: T,
  config: GovernToolConfig,
): Promise<T & GovernedResult> {
  const result = await registerAgent(governance, config, [tool.name]);
  const enforce = createEnforcer(governance, result.id, result.level, config);
  const audit = createAuditor(governance, result.id);

  const governed = {
    ...tool,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    invoke: async (input: unknown, config?: LangChainRunnableConfig): Promise<unknown> => {
      await enforce(tool.name, input);

      try {
        const output = await tool.invoke(input, config);
        await audit(tool.name, "success");
        return output;
      } catch (error) {
        await audit(tool.name, "failure", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };

  return governed as T & GovernedResult;
}

// ─── Govern Multiple Tools ──────────────────────────────────────

/**
 * Wrap multiple LangChain tools with governance enforcement.
 *
 * Registers a single agent with all tool names, then wraps each tool's invoke.
 */
export async function governTools<T extends LangChainTool>(
  governance: GovernanceInstance,
  tools: T[],
  config: GovernToolConfig,
): Promise<{ tools: T[]; agentId: string; score: number; level: number }> {
  const toolNames = tools.map((t) => t.name);
  const result = await registerAgent(governance, config, toolNames);
  const enforce = createEnforcer(governance, result.id, result.level, config);
  const audit = createAuditor(governance, result.id);

  const governed = tools.map((tool) => ({
    ...tool,
    invoke: async (input: unknown, config?: LangChainRunnableConfig): Promise<unknown> => {
      await enforce(tool.name, input);

      try {
        const output = await tool.invoke(input, config);
        await audit(tool.name, "success");
        return output;
      } catch (error) {
        await audit(tool.name, "failure", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  }));

  return {
    tools: governed as T[],
    agentId: result.id,
    score: result.score,
    level: result.level,
  };
}

// ─── Pre/post model wrapper ─────────────────────────────────────
// See ./langchain-model.ts for docs + examples.
export type {
  LangChainMessage,
  LangChainChatModel,
  LangChainModelConfig,
} from "./langchain-model.js";
export { wrapChatModel } from "./langchain-model.js";
