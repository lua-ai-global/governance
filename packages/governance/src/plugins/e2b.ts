/**
 * @lua-ai-global/governance E2B Sandbox Plugin
 *
 * Integrates governance enforcement into E2B sandbox operations.
 * Wraps code execution, filesystem ops, and process spawning with
 * before-action policy checks and audit logging.
 *
 * @example
 * ```ts
 * import { createGovernance } from '@lua-ai-global/governance';
 * import { governE2BSandbox } from '@lua-ai-global/governance/plugins/e2b';
 *
 * const gov = createGovernance();
 *
 * const { executeCode, filesystem, spawn } = await governE2BSandbox(gov, {
 *   codeHandler: (exec) => sandbox.runCode(exec.code, { language: exec.language }),
 *   filesystemHandler: (op) => sandbox.filesystem[op.operation](op.path, op.content),
 *   processHandler: (proc) => sandbox.process.start(proc.command, proc.args),
 * }, {
 *   agentName: 'sandbox-runner',
 *   owner: 'dev-team',
 * });
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  E2BCodeExecution, E2BExecutionResult,
  E2BFilesystemOp, E2BCommandExecution,
  E2BCodeHandler, E2BFilesystemHandler, E2BCommandHandler,
  GovernE2BConfig, GovernedE2BResult,
} from "./e2b-types";

// Re-export all types
export type {
  E2BCodeExecution, E2BExecutionResult, E2BResult, E2BError, E2BOutputMessage,
  E2BFilesystemOp, E2BCommandExecution,
  E2BCodeHandler, E2BFilesystemHandler, E2BCommandHandler,
  GovernE2BConfig, GovernedE2BResult,
} from "./e2b-types";

// ─── Blocked Error ──────────────────────────────────────────

export class GovernanceBlockedError extends Error {
  public readonly decision: EnforcementDecision;
  public readonly context: string;

  constructor(decision: EnforcementDecision, context: string) {
    super(`Governance blocked: ${decision.reason} (context: ${context})`);
    this.name = "GovernanceBlockedError";
    this.decision = decision;
    this.context = context;
  }
}

// ─── Shared Helpers ─────────────────────────────────────────

function buildRegistration(config: GovernE2BConfig): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "e2b",
    owner: config.owner,
    description: config.description,
    version: config.version,
    channels: config.channels,
    tools: ["code_execution", "filesystem", "process_spawn"],
    hasAuth: config.hasAuth,
    hasGuardrails: config.hasGuardrails,
    hasObservability: config.hasObservability,
    hasAuditLog: true,
    permissions: config.permissions,
    metadata: config.metadata,
  };
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernE2BConfig) {
  return async (context: string, input?: Record<string, unknown>): Promise<EnforcementDecision> => {
    const action = config.actionMapper?.(context) ?? ("tool_call" as PolicyAction);
    const decision = await governance.enforce({
      agentId, agentName: config.agentName, agentLevel: 0,
      action, tool: context, input,
      sessionTokensUsed: config.sessionTokenTracker?.(),
    });
    config.onDecision?.(decision, context);
    if (decision.blocked) config.onBlocked?.(decision, context);
    return decision;
  };
}

function createAuditor(governance: GovernanceInstance, agentId: string) {
  return (context: string, outcome: "success" | "failure", detail?: Record<string, unknown>): Promise<AuditEvent> =>
    governance.audit.log({
      agentId, eventType: "tool_call", outcome,
      severity: outcome === "failure" ? "warning" : "info",
      detail: { tool: context, ...detail },
    });
}

function matchesBlockedPattern(code: string, patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    if (new RegExp(pattern).test(code)) return pattern;
  }
  return undefined;
}

// ─── Handler Config ─────────────────────────────────────────

export interface E2BHandlers {
  codeHandler: E2BCodeHandler;
  filesystemHandler?: E2BFilesystemHandler;
  /** Command handler (formerly processHandler) */
  commandHandler?: E2BCommandHandler;
  /** @deprecated Use commandHandler instead */
  processHandler?: E2BCommandHandler;
}

// ─── Main Export ────────────────────────────────────────────

export async function governE2BSandbox(
  governance: GovernanceInstance,
  handlers: E2BHandlers,
  config: GovernE2BConfig,
): Promise<GovernedE2BResult> {
  const reg = buildRegistration(config);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  async function executeCode(execution: E2BCodeExecution): Promise<E2BExecutionResult> {
    // Check blocked patterns first
    if (config.blockedPatterns) {
      const matched = matchesBlockedPattern(execution.code, config.blockedPatterns);
      if (matched) {
        await audit("code_execution", "failure", { reason: `Blocked pattern: ${matched}` });
        throw new GovernanceBlockedError(
          { blocked: true, reason: `Code matches blocked pattern: ${matched}`, ruleId: "blocked_pattern", outcome: "block", evaluatedAt: new Date().toISOString(), rulesEvaluated: 1 },
          "code_execution",
        );
      }
    }

    const decision = await enforce("code_execution", {
      code: execution.code, language: execution.language,
    });
    if (decision.blocked) throw new GovernanceBlockedError(decision, "code_execution");

    try {
      const output = await handlers.codeHandler(execution);
      await audit("code_execution", "success", { language: execution.language });
      return output;
    } catch (error) {
      await audit("code_execution", "failure", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function filesystem(op: E2BFilesystemOp): Promise<unknown> {
    if (!handlers.filesystemHandler) throw new Error("No filesystem handler configured");

    const decision = await enforce("filesystem", { operation: op.operation, path: op.path });
    if (decision.blocked) throw new GovernanceBlockedError(decision, "filesystem");

    try {
      const output = await handlers.filesystemHandler(op);
      await audit("filesystem", "success", { operation: op.operation, path: op.path });
      return output;
    } catch (error) {
      await audit("filesystem", "failure", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function spawn(cmd: E2BCommandExecution): Promise<unknown> {
    const handler = handlers.commandHandler ?? handlers.processHandler;
    if (!handler) throw new Error("No command handler configured");

    const decision = await enforce("command_execution", { command: cmd.command });
    if (decision.blocked) throw new GovernanceBlockedError(decision, "command_execution");

    try {
      const output = await handler(cmd);
      await audit("command_execution", "success", { command: cmd.command });
      return output;
    } catch (error) {
      await audit("command_execution", "failure", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  return {
    executeCode,
    filesystem,
    spawn,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}
