/**
 * governance-sdk A2A (Agent-to-Agent Protocol) Plugin
 *
 * Integrates governance enforcement into Google's A2A protocol.
 * Governs both outbound message sends and inbound message receives.
 *
 * Updated March 2026 for A2A spec v0.2.6+: message-centric model,
 * contextId replaces sessionId, kind replaces type on parts.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { createGovernedA2A } from 'governance-sdk/plugins/a2a';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['untrusted-agent.example.com'])],
 * });
 *
 * const { sendMessage, receiveMessage } = await createGovernedA2A(
 *   gov, originalSendHandler, originalReceiveHandler, {
 *     agentName: 'my-a2a-agent',
 *     owner: 'platform-team',
 *   },
 * );
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  A2AAgentCard, A2AMessageSendRequest, A2ASendTaskRequest, A2ATask,
  GovernA2AConfig, GovernedA2AResult,
  A2AMessageSendHandler, A2AMessageReceiveHandler,
} from "./a2a-types.js";

// Re-export all types
export type {
  A2AAgentCard, A2ACapabilities, A2ASkill, A2ATask, A2ATaskStatus, A2ATaskState,
  A2AMessage, A2APart, A2AArtifact,
  A2AMessageSendRequest, A2AMessageSendParams, A2ASendTaskRequest,
  A2ASecurityScheme,
  GovernA2AConfig, GovernedA2AResult,
  A2AMessageSendHandler, A2AMessageReceiveHandler,
  A2ATaskSendHandler, A2ATaskReceiveHandler,
} from "./a2a-types.js";

import { handleOutcome, GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";
import type { OutcomeCallbacks } from "./outcome-handler.js";

// ─── Blocked Error ──────────────────────────────────────────

export { GovernanceBlockedError, GovernanceApprovalRequiredError } from "./outcome-handler.js";

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernA2AConfig): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "custom",
    owner: config.owner,
    description: config.description,
    version: config.version,
    channels: config.channels,
    hasAuth: config.hasAuth,
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: true,
    permissions: config.permissions,
    metadata: { ...config.metadata, protocol: "a2a" },
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernA2AConfig) {
  return async (context: string, input?: Record<string, unknown>): Promise<EnforcementDecision> => {
    const action = config.actionMapper?.(context) ?? ("external_request" as PolicyAction);
    const decision = await governance.enforce({
      agentId, agentName: config.agentName, agentLevel: 0,
      action, tool: context, input,
      sessionTokensUsed: config.sessionTokenTracker?.(),
    });
    handleOutcome(decision, context, config as OutcomeCallbacks);
    return decision;
  };
}

function createAuditor(governance: GovernanceInstance, agentId: string) {
  return (context: string, outcome: "success" | "failure", detail?: Record<string, unknown>): Promise<AuditEvent> =>
    governance.audit.log({
      agentId, eventType: "tool_call", outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: { context, ...detail },
    });
}

// ─── Create Governed A2A ────────────────────────────────────

export async function createGovernedA2A(
  governance: GovernanceInstance,
  sendHandler: A2AMessageSendHandler,
  receiveHandler: A2AMessageReceiveHandler,
  config: GovernA2AConfig,
): Promise<GovernedA2AResult> {
  const reg = buildRegistration(config);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  async function sendMessage(request: A2AMessageSendRequest, targetAgent: A2AAgentCard): Promise<A2ATask> {
    const context = `send:${targetAgent.name}@${targetAgent.url}`;
    const targetAction = config.targetAgentMapper?.(targetAgent.url);

    if (targetAction) {
      const decision = await governance.enforce({
        agentId: result.id, agentName: config.agentName, agentLevel: 0,
        action: targetAction, tool: context,
        input: { messageId: request.params.message.messageId, targetUrl: targetAgent.url },
      });
      handleOutcome(decision, context, config as OutcomeCallbacks);
    } else {
      await enforce(context, {
        messageId: request.params.message.messageId,
        targetAgent: targetAgent.name,
        targetUrl: targetAgent.url,
        messageRole: request.params.message.role,
      });
    }

    try {
      const task = await sendHandler(request, targetAgent);
      await audit(context, "success", {
        type: "a2a_send", messageId: request.params.message.messageId,
        targetAgent: targetAgent.name, taskState: task.status.state,
      });
      return task;
    } catch (error) {
      await audit(context, "failure", {
        type: "a2a_send", messageId: request.params.message.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function receiveMessage(request: A2AMessageSendRequest, fromAgent?: A2AAgentCard): Promise<A2ATask> {
    const senderName = fromAgent?.name ?? "unknown";
    const context = `receive:${senderName}`;

    await enforce(context, {
      messageId: request.params.message.messageId,
      fromAgent: senderName,
      fromUrl: fromAgent?.url,
      messageRole: request.params.message.role,
    });

    try {
      const task = await receiveHandler(request, fromAgent);
      await audit(context, "success", {
        type: "a2a_receive", messageId: request.params.message.messageId,
        fromAgent: senderName, taskState: task.status.state,
      });
      return task;
    } catch (error) {
      await audit(context, "failure", {
        type: "a2a_receive", messageId: request.params.message.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Legacy aliases for backward compat
  const sendTask = sendMessage as unknown as (req: A2ASendTaskRequest, target: A2AAgentCard) => Promise<A2ATask>;
  const receiveTask = receiveMessage as unknown as (req: A2ASendTaskRequest, from?: A2AAgentCard) => Promise<A2ATask>;

  return {
    sendMessage,
    receiveMessage,
    sendTask,
    receiveTask,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}
