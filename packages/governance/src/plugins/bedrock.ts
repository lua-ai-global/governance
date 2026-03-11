/**
 * @lua-ai-global/governance AWS Bedrock Agents Plugin
 *
 * Integrates governance enforcement into AWS Bedrock agent invocations.
 * Wraps invokeAgent calls and action group execution with policy checks.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from '@lua-ai-global/governance';
 * import { createGovernedBedrock } from '@lua-ai-global/governance/plugins/bedrock';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['delete_records', 'send_email'])],
 * });
 *
 * const { invokeAgent, guardActionGroup } = await createGovernedBedrock(
 *   gov, originalInvokeAgent, {
 *     agentName: 'bedrock-assistant',
 *     owner: 'cloud-team',
 *   },
 * );
 *
 * // Use governed invokeAgent instead of direct SDK call
 * const response = await invokeAgent({ agentId: '...', ... });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  BedrockInvokeAgentInput, BedrockActionGroupInvocation, BedrockToolUseBlock,
  GovernBedrockConfig, GovernedBedrockResult, BedrockInvokeHandler,
} from "./bedrock-types.js";

// Re-export all types
export type {
  BedrockInvokeAgentInput, BedrockActionGroupInvocation, BedrockActionParameter,
  BedrockResponseChunk, BedrockTrace,
  BedrockToolUseBlock, BedrockToolResultBlock, BedrockToolResultContent,
  BedrockContentBlock, BedrockToolSpec, BedrockTool, BedrockToolChoice,
  BedrockToolConfiguration,
  GovernBedrockConfig, GovernedBedrockResult, BedrockInvokeHandler,
} from "./bedrock-types.js";

// ─── Blocked Error ──────────────────────────────────────────

export class GovernanceBlockedError extends Error {
  public readonly decision: EnforcementDecision;
  public readonly toolName: string;

  constructor(decision: EnforcementDecision, toolName: string) {
    super(`Governance blocked: ${decision.reason} (tool: ${toolName})`);
    this.name = "GovernanceBlockedError";
    this.decision = decision;
    this.toolName = toolName;
  }
}

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernBedrockConfig): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "bedrock",
    owner: config.owner,
    description: config.description,
    version: config.version,
    channels: config.channels,
    tools: config.tools,
    hasAuth: config.hasAuth ?? true, // Bedrock uses IAM auth by default
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: true,
    permissions: config.permissions,
    metadata: config.metadata,
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernBedrockConfig) {
  return async (toolName: string, input?: Record<string, unknown>): Promise<EnforcementDecision> => {
    const action = config.actionMapper?.(toolName) ?? ("tool_call" as PolicyAction);
    const decision = await governance.enforce({
      agentId, agentName: config.agentName, agentLevel: 0,
      action, tool: toolName, input,
      sessionTokensUsed: config.sessionTokenTracker?.(),
    });
    config.onDecision?.(decision, toolName);
    if (decision.blocked) config.onBlocked?.(decision, toolName);
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

// ─── Create Governed Bedrock ────────────────────────────────

/**
 * Create a governed AWS Bedrock agent wrapper.
 *
 * Wraps an existing invokeAgent handler with governance enforcement.
 * Also provides a guardActionGroup method for action-level governance.
 */
export async function createGovernedBedrock(
  governance: GovernanceInstance,
  invokeHandler: BedrockInvokeHandler,
  config: GovernBedrockConfig,
): Promise<GovernedBedrockResult> {
  const reg = buildRegistration(config);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  async function invokeAgent(input: BedrockInvokeAgentInput): Promise<unknown> {
    const toolName = `bedrock:${input.agentId}:${input.agentAliasId}`;
    const decision = await enforce(toolName, {
      agentId: input.agentId,
      agentAliasId: input.agentAliasId,
      sessionId: input.sessionId,
      inputText: input.inputText,
    });

    if (decision.blocked) {
      throw new GovernanceBlockedError(decision, toolName);
    }

    try {
      const response = await invokeHandler(input);
      await audit(toolName, "success", { sessionId: input.sessionId });
      return response;
    } catch (error) {
      await audit(toolName, "failure", {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function guardActionGroup(invocation: BedrockActionGroupInvocation): Promise<EnforcementDecision> {
    const toolName = invocation.actionGroupName;
    const input: Record<string, unknown> = {
      apiPath: invocation.apiPath,
      verb: invocation.verb,
    };

    if (invocation.parameters) {
      input.parameters = invocation.parameters.map((p) => ({ name: p.name, value: p.value }));
    }

    const decision = await enforce(toolName, input);

    if (decision.blocked) {
      await audit(toolName, "failure", { reason: decision.reason, type: "action_group_blocked" });
    } else {
      await audit(toolName, "success", { type: "action_group_allowed" });
    }

    return decision;
  }

  async function guardToolUse(block: BedrockToolUseBlock): Promise<EnforcementDecision> {
    const toolName = block.name;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const decision = await enforce(toolName, { toolUseId: block.toolUseId, ...input });

    if (decision.blocked) {
      await audit(toolName, "failure", { reason: decision.reason, type: "tool_use_blocked", toolUseId: block.toolUseId });
    } else {
      await audit(toolName, "success", { type: "tool_use_allowed", toolUseId: block.toolUseId });
    }

    return decision;
  }

  return {
    invokeAgent,
    guardActionGroup,
    guardToolUse,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}
