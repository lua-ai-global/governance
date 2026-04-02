/**
 * governance-sdk Microsoft Semantic Kernel Plugin
 *
 * Integrates governance enforcement into Semantic Kernel function execution.
 * Wraps kernel functions and provides a FunctionFilter for kernel-level integration.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools } from 'governance-sdk';
 * import { governSKFunctions } from 'governance-sdk/plugins/semantic-kernel';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['delete_file', 'send_payment'])],
 * });
 *
 * const { functions, filter } = await governSKFunctions(gov, myFunctions, {
 *   agentName: 'sk-agent',
 *   owner: 'ai-team',
 * });
 *
 * // Option 1: Use governed functions directly
 * // Option 2: Add filter to kernel for automatic governance
 * kernel.addFunctionFilter(filter);
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "../index";
import type { EnforcementDecision, PolicyAction } from "../policy";
import type { AgentRegistration } from "../types";
import type {
  KernelFunction, KernelPlugin, FunctionFilter, FunctionFilterContext,
  GovernSKConfig, GovernedSKResult, GovernedSKPluginResult,
} from "./semantic-kernel-types.js";

// Re-export all types
export type {
  KernelFunction, KernelParameter, KernelPlugin,
  FunctionFilter, FunctionFilterContext,
  GovernSKConfig, GovernedSKResult, GovernedSKPluginResult,
} from "./semantic-kernel-types.js";

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

function buildRegistration(config: GovernSKConfig, toolNames: string[]): AgentRegistration {
  return {
    name: config.agentName,
    framework: config.framework ?? "semantic-kernel",
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
}

function createEnforcer(governance: GovernanceInstance, agentId: string, config: GovernSKConfig) {
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

function getFunctionFullName(fn: KernelFunction): string {
  return fn.pluginName ? `${fn.pluginName}.${fn.name}` : fn.name;
}

function wrapFunction(
  fn: KernelFunction,
  enforce: ReturnType<typeof createEnforcer>,
  audit: ReturnType<typeof createAuditor>,
): KernelFunction {
  const fullName = getFunctionFullName(fn);
  return {
    ...fn,
    invoke: async (args: Record<string, unknown>): Promise<unknown> => {
      const decision = await enforce(fullName, args);
      if (decision.blocked) throw new GovernanceBlockedError(decision, fullName);
      try {
        const output = await fn.invoke(args);
        await audit(fullName, "success");
        return output;
      } catch (error) {
        await audit(fullName, "failure", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}

// ─── Govern SK Functions ────────────────────────────────────

export async function governSKFunctions(
  governance: GovernanceInstance,
  functions: KernelFunction[],
  config: GovernSKConfig,
): Promise<GovernedSKResult> {
  const toolNames = functions.map(getFunctionFullName);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  const filter: FunctionFilter = {
    onFunctionInvocation: async (context: FunctionFilterContext, next: (ctx: FunctionFilterContext) => Promise<void>) => {
      const fullName = getFunctionFullName(context.function);
      const decision = await enforce(fullName, context.arguments);
      if (decision.blocked) throw new GovernanceBlockedError(decision, fullName);
      await next(context);
      await audit(fullName, "success");
    },
  };

  return {
    functions: functions.map((fn) => wrapFunction(fn, enforce, audit)),
    filter,
    agentId: result.id,
    score: result.score,
    level: result.level,
    governance,
    enforce,
    audit,
  };
}

// ─── Govern SK Plugin ───────────────────────────────────────

export async function governSKPlugin(
  governance: GovernanceInstance,
  plugin: KernelPlugin,
  config: GovernSKConfig,
): Promise<GovernedSKPluginResult> {
  const fns = Object.values(plugin.functions);
  const toolNames = fns.map(getFunctionFullName);
  const reg = buildRegistration(config, toolNames);
  const result = await governance.register(reg);

  const enforce = createEnforcer(governance, result.id, config);
  const audit = createAuditor(governance, result.id);

  const wrappedFunctions: Record<string, KernelFunction> = {};
  for (const [key, fn] of Object.entries(plugin.functions)) {
    wrappedFunctions[key] = wrapFunction(fn, enforce, audit);
  }

  return {
    plugin: {
      ...plugin,
      functions: wrappedFunctions,
    },
    agentId: result.id,
    score: result.score,
    level: result.level,
  };
}
