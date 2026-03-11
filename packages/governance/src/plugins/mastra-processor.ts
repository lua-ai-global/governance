/**
 * @lua-ai-global/governance — Native Mastra Processor
 *
 * Framework-level governance integration for Mastra agents.
 * Intercepts ALL tool calls at the pipeline level — zero per-tool config.
 * Types are in mastra-processor-types.ts.
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementContext, EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  MastraProcessorInterface,
  MastraToolCallInfo,
  ProcessOutputStepArgs,
  GovernanceProcessorConfig,
  GovernanceViolation,
  ProcessorStats,
} from "./mastra-processor-types";

// Re-export all types
export type {
  MastraToolCallInfo,
  MastraAbortOptions,
  GovernanceViolation,
  MastraAbortFn,
  MastraMessage,
  MastraStreamWriter,
  ProcessOutputStepArgs,
  MastraProcessorInterface,
  GovernanceProcessorConfig,
  ProcessorStats,
} from "./mastra-processor-types";

// ─── GovernanceProcessor ──────────────────────────────────────

export class GovernanceProcessor implements MastraProcessorInterface {
  readonly id = "lua-governance" as const;
  readonly name = "Lua Governance Processor";

  private governance: GovernanceInstance;
  private config: GovernanceProcessorConfig;
  private agentId: string | null = null;
  private agentLevel: number = 0;
  private registrationPromise: Promise<void> | null = null;
  private stats: ProcessorStats = {
    totalProcessed: 0, totalBlocked: 0, totalAllowed: 0,
    byTool: {}, initializedAt: new Date().toISOString(),
  };

  constructor(governance: GovernanceInstance, config: GovernanceProcessorConfig) {
    this.governance = governance;
    this.config = config;
  }

  private async ensureRegistered(): Promise<void> {
    if (this.agentId) return;
    if (!this.registrationPromise) this.registrationPromise = this.doRegister();
    await this.registrationPromise;
  }

  private async doRegister(): Promise<void> {
    const registration: AgentRegistration = {
      name: this.config.agentName,
      framework: this.config.framework ?? "mastra",
      owner: this.config.owner,
      description: this.config.description,
      version: this.config.version,
      channels: this.config.channels,
      hasAuth: this.config.hasAuth,
      hasGuardrails: this.config.hasGuardrails,
      hasObservability: this.config.hasObservability,
      hasAuditLog: this.config.hasAuditLog ?? true,
      permissions: this.config.permissions,
      metadata: this.config.metadata,
    };
    const result = await this.governance.register(registration);
    this.agentId = result.id;
    this.agentLevel = result.level;
  }

  async processOutputStep(args: ProcessOutputStepArgs): Promise<void> {
    const { toolCalls, abort, retryCount } = args;
    if (!toolCalls || toolCalls.length === 0) return;

    await this.ensureRegistered();

    const abortOnBlock = this.config.abortOnBlock ?? true;
    const retryOnBlock = this.config.retryOnBlock ?? false;
    const maxRetries = this.config.maxRetries ?? 2;
    const violations: GovernanceViolation[] = [];

    for (const toolCall of toolCalls) {
      const decision = await this.evaluateToolCall(toolCall);

      this.stats.totalProcessed++;
      if (!this.stats.byTool[toolCall.toolName]) {
        this.stats.byTool[toolCall.toolName] = { allowed: 0, blocked: 0 };
      }

      if (decision.blocked) {
        this.stats.totalBlocked++;
        this.stats.byTool[toolCall.toolName].blocked++;
        this.config.onBlocked?.(decision, toolCall);

        violations.push({
          toolName: toolCall.toolName,
          ruleId: decision.ruleId ?? "unknown",
          reason: decision.reason ?? "Policy violation",
          decision,
        });

        if (abortOnBlock) {
          const message = this.config.abortMessage
            ? this.config.abortMessage(decision, toolCall)
            : `[GOVERNANCE] Blocked: ${toolCall.toolName} — ${decision.reason} (rule: ${decision.ruleId})`;

          if (retryOnBlock && retryCount < maxRetries) {
            abort(`${message}. Please choose a different approach that doesn't use blocked tools.`, { retry: true, metadata: { violations } });
          } else {
            abort(message, { retry: false, metadata: { violations } });
          }
          return;
        }
      } else {
        this.stats.totalAllowed++;
        this.stats.byTool[toolCall.toolName].allowed++;
      }

      this.config.onDecision?.(decision, toolCall);
    }
  }

  private async evaluateToolCall(toolCall: MastraToolCallInfo): Promise<EnforcementDecision> {
    const action = this.config.actionMapper
      ? this.config.actionMapper(toolCall.toolName)
      : "tool_call" as PolicyAction;

    const ctx: EnforcementContext = {
      agentId: this.agentId!,
      agentName: this.config.agentName,
      agentLevel: this.agentLevel,
      action, tool: toolCall.toolName,
      input: toolCall.args as Record<string, unknown> | undefined,
      sessionTokensUsed: this.config.sessionTokenTracker?.(),
    };
    return this.governance.enforce(ctx);
  }

  getAgentId(): string | null { return this.agentId; }
  getAgentLevel(): number { return this.agentLevel; }
  getStats(): ProcessorStats { return { ...this.stats }; }
  getGovernance(): GovernanceInstance { return this.governance; }

  async logToolResult(toolName: string, outcome: "success" | "failure", detail?: Record<string, unknown>): Promise<AuditEvent> {
    await this.ensureRegistered();
    return this.governance.audit.log({
      agentId: this.agentId!, eventType: "tool_call", outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: { tool: toolName, ...detail },
    });
  }

  resetStats(): void {
    this.stats = { totalProcessed: 0, totalBlocked: 0, totalAllowed: 0, byTool: {}, initializedAt: new Date().toISOString() };
  }
}
