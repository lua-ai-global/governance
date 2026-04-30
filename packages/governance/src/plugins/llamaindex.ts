/**
 * governance-sdk LlamaIndex Plugin
 *
 * Integrates governance enforcement into LlamaIndex tool execution.
 * Wraps tools with before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governLlamaIndexTools } from 'governance-sdk/plugins/llamaindex';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['file_delete', 'shell_exec'])],
 * });
 *
 * const { tools } = await governLlamaIndexTools(gov, [searchTool, writeTool], {
 *   agentName: 'llamaindex-agent',
 *   owner: 'ai-team',
 * });
 *
 * // Use governed tools in your LlamaIndex agent
 * const agent = new OpenAIAgent({ tools });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  LlamaIndexTool, LlamaIndexAgent, LlamaIndexJSONValue,
  GovernLlamaIndexConfig, GovernedLlamaIndexToolsResult, GovernedLlamaIndexAgentResult,
} from "./llamaindex-types.js";

// Re-export all types
export type {
  LlamaIndexTool, LlamaIndexToolMetadata, LlamaIndexToolOutput, LlamaIndexJSONValue,
  LlamaIndexQueryEngineTool, LlamaIndexAgent,
  GovernLlamaIndexConfig, GovernedLlamaIndexToolsResult, GovernedLlamaIndexAgentResult,
} from "./llamaindex-types.js";

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";
import { scanToolResult } from "../tool-result-scan.js";

// ─── Pre/post LLM wrapper ───────────────────────────────────
// See ./llamaindex-llm.ts for docs + examples.
export type {
  LlamaChatMessage,
  LlamaChatRequest,
  LlamaChatResponse,
  LlamaChatResponseChunk,
  LlamaLLM,
  LlamaLLMConfig,
} from "./llamaindex-llm.js";
export { wrapLlamaLLM } from "./llamaindex-llm.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernLlamaIndexConfig, toolNames: string[]): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "custom",
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
    metadata: { ...config.metadata, runtime: "llamaindex" },
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernLlamaIndexConfig) {
  return async (toolName: string, input?: Record<string, unknown>): Promise<EnforcementDecision> => {
    const action = config.actionMapper?.(toolName) ?? ("tool_call" as PolicyAction);
    const decision = await governance.enforce({
      agentId, agentName: config.agentName, agentLevel: 0,
      action, tool: toolName, input,
      sessionTokensUsed: config.sessionTokenTracker?.(),
    });
    handleOutcome(decision, toolName, config as OutcomeCallbacks);
    return decision;
  };
}

function createAuditor(governance: GovernanceInstance, agentId: string) {
  return (toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>): Promise<AuditEvent> =>
    governance.audit.log({
      agentId, eventType: "tool_call", outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: { tool: toolName, ...detail },
    });
}

/**
 * Build a result-scan closure bound to this governance + agent. Runs the
 * tool's raw output through the policy engine at stage `tool_result` and
 * returns either the original (allow) or a redacted detail object (block).
 * No-op when `config.scanToolResults === false`. Default-on.
 */
function createResultScanner(
  governance: GovernanceInstance, agentId: string, config: GovernLlamaIndexConfig,
) {
  return async (toolName: string, args: Record<string, unknown> | undefined, output: LlamaIndexJSONValue): Promise<LlamaIndexJSONValue> => {
    if (config.scanToolResults === false) return output;
    const scanned = await scanToolResult({
      governance, agentId, agentName: config.agentName, tool: toolName,
      args, result: output,
      injectionThreshold: config.toolResultInjectionThreshold,
    });
    // BlockedToolResult.ruleId is `string | null`, but LlamaIndexJSONValue
    // explicitly excludes `null` per the SDK contract. Coerce on block so
    // downstream LlamaIndex JSON walkers don't trip on the null property.
    if (scanned.blocked) {
      const blocked = scanned.result as { blocked: true; reason: string; ruleId: string | null };
      return {
        blocked: true,
        reason: blocked.reason,
        ruleId: blocked.ruleId ?? "unknown",
      };
    }
    return scanned.result as LlamaIndexJSONValue;
  };
}

function wrapTool(
  tool: LlamaIndexTool,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
  scanResult: ReturnType<typeof createResultScanner>,
): LlamaIndexTool {
  if (!tool.call) return tool;
  const toolName = tool.metadata.name;
  return {
    ...tool,
    call: async (input: Record<string, unknown>): Promise<LlamaIndexJSONValue> => {
      const decision = await enforce(toolName, input);
      try {
        const output = await tool.call!(input);
        const finalOutput = await scanResult(toolName, input, output);
        await audit(toolName, "success");
        return finalOutput;
      } catch (error) {
        await audit(toolName, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}

// ─── Govern LlamaIndex Tools ────────────────────────────────

export async function governLlamaIndexTools(
  governance: GovernanceInstance,
  tools: LlamaIndexTool[],
  config: GovernLlamaIndexConfig,
): Promise<GovernedLlamaIndexToolsResult> {
  const toolNames = tools.map((t) => t.metadata.name);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);
  const scanResult = createResultScanner(governance, result.id, config);

  return {
    tools: tools.map((tool) => wrapTool(tool, enforce, audit, scanResult)),
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}

// ─── Govern LlamaIndex Agent ────────────────────────────────

export async function governLlamaIndexAgent(
  governance: GovernanceInstance,
  agent: LlamaIndexAgent,
  config: GovernLlamaIndexConfig,
): Promise<GovernedLlamaIndexAgentResult> {
  const toolNames = agent.tools.map((t) => t.metadata.name);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);
  const scanResult = createResultScanner(governance, result.id, config);

  return {
    agent: { ...agent, tools: agent.tools.map((tool) => wrapTool(tool, enforce, audit, scanResult)) },
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}
