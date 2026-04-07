/**
 * governance-sdk — Runtime governance for TypeScript AI agents.
 *
 * @example
 * ```ts
 * import { createGovernance, blockTools, requireLevel } from 'governance-sdk';
 *
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec']), requireLevel(2)],
 * });
 *
 * const agent = await gov.register({
 *   name: 'sales-agent', framework: 'mastra', owner: 'sales-team',
 *   tools: ['email_draft', 'crm_update'], hasAuth: true,
 * });
 *
 * const decision = await gov.enforce({
 *   agentId: agent.id, agentName: 'sales-agent',
 *   agentLevel: agent.level, action: 'tool_call', tool: 'shell_exec',
 * });
 * // decision.blocked === true
 * ```
 *
 * @packageDocumentation
 */

import { assessAgent, assessFleet, getGovernanceLevel, computeCompositeScore } from "./scorer.js";
import { createPolicyEngine } from "./policy.js";
import { createMemoryStorage } from "./storage.js";
import { createRemoteEnforcer, validateRemoteConfig } from "./remote-enforce.js";
import { computeBehavioralAdjustments, applyBehavioralAdjustments } from "./behavioral-scorer.js";
import { computeEvalAdjustments, applyEvalAdjustments } from "./eval-scorer.js";
import { createTraceCollector } from "./eval-trace.js";
import { runRedTeam } from "./eval-red-team.js";
import type { AgentRegistration, GovernanceAssessment, FleetSummary } from "./types.js";
import type { PolicyRule, PolicyEngine, PolicyStage, EnforcementContext, EnforcementDecision } from "./policy.js";
import type { GovernanceStorage, StoredAgent, AuditEvent, AuditQueryFilters } from "./storage.js";
import type { EvalResult, TraceCollector } from "./eval-types.js";
import type { RedTeamConfig, RedTeamReport } from "./eval-red-team.js";

// Re-export storage types (other modules import from ./index)
export type { GovernanceStorage, StoredAgent, AuditEvent, AuditOutcome, AuditQueryFilters } from "./storage.js";
export { createMemoryStorage } from "./storage.js";

// ─── Governance Instance ────────────────────────────────────────

/** Configuration for createGovernance() */
export interface GovernanceConfig {
  storage?: GovernanceStorage;
  rules?: PolicyRule[];
  defaultOutcome?: "allow" | "block";
  /** When set, enforce() and register() POST to this URL instead of running locally */
  serverUrl?: string;
  /** Bearer token for remote calls — required when serverUrl is set */
  apiKey?: string;
  /** Request timeout in ms for remote calls (default: 30000) */
  timeout?: number;
  /** Max retry attempts for transient remote failures (default: 3) */
  maxRetries?: number;
  /** What to do when the API is unreachable after retries: "allow" (fail-open) or "block" (fail-closed). Default: "allow" */
  fallbackMode?: "allow" | "block";
  /** Called when a fire-and-forget audit write fails. Audit errors never block enforcement. */
  onAuditError?: (error: unknown) => void;
}

/** Read-only view of the policy engine — addRule/removeRule are not exposed */
export interface ReadonlyPolicyEngine {
  evaluate: (ctx: EnforcementContext) => EnforcementDecision;
  evaluateStage: (ctx: EnforcementContext, stage: PolicyStage) => EnforcementDecision;
  getRules: (stage?: PolicyStage) => PolicyRule[];
  readonly ruleCount: number;
}

/** The main governance instance returned by createGovernance() */
export interface GovernanceInstance {
  register: (input: AgentRegistration) => Promise<{
    id: string; score: number; level: number; status: string;
    assessment: GovernanceAssessment;
  }>;
  enforce: (ctx: EnforcementContext) => Promise<EnforcementDecision>;
  /** Evaluate only preprocess-stage rules */
  enforcePreprocess: (ctx: EnforcementContext) => Promise<EnforcementDecision>;
  /** Evaluate only postprocess-stage rules */
  enforcePostprocess: (ctx: EnforcementContext) => Promise<EnforcementDecision>;
  audit: {
    log: (event: Omit<AuditEvent, "id" | "createdAt">) => Promise<AuditEvent>;
    query: (filters: AuditQueryFilters) => Promise<AuditEvent[]>;
    count: (filters?: AuditQueryFilters) => Promise<number>;
  };
  score: (agentId: string) => Promise<GovernanceAssessment | null>;
  scoreFleet: () => Promise<{ assessments: GovernanceAssessment[]; summary: FleetSummary }>;
  /** Read-only view — use addRule()/removeRule() on the instance for mutations */
  policies: ReadonlyPolicyEngine;
  /** Direct storage access for queries — mutations should go through instance methods */
  storage: GovernanceStorage;
  /** Add a policy rule (instrumented — prefer this over direct policies.addRule) */
  addRule: (rule: PolicyRule) => void;
  /** Remove a policy rule by ID */
  removeRule: (ruleId: string) => void;
  /** Eval loop — submit results, access traces, run red team */
  eval: {
    /** Submit eval results for an agent (feeds into scoring via score()) */
    submit: (result: EvalResult) => void;
    /** Get recent eval results for an agent */
    getResults: (agentId: string) => EvalResult[];
    /** Clear eval results for an agent */
    clear: (agentId: string) => void;
    /** Trace collector for wiring into framework adapters */
    traces: TraceCollector;
    /** Run adversarial policy effectiveness suite */
    runRedTeam: (agentId: string, config?: RedTeamConfig) => Promise<RedTeamReport>;
  };
  /** Test API connectivity. Returns status without throwing. */
  connect: () => Promise<{ connected: boolean; mode: string; latencyMs: number }>;
  /** Current connection status (cached from last enforce/connect call). */
  status: () => { connected: boolean; mode: string; latencyMs: number };
  /** Poll an approval until resolved. Returns final status. */
  waitForApproval: (approvalId: string, opts?: { timeoutMs?: number; pollIntervalMs?: number }) => Promise<"approved" | "denied" | "expired" | "timeout">;
}

/** Reconstruct an AgentRegistration from a StoredAgent, including capability booleans from metadata. */
function storedToRegistration(agent: StoredAgent): AgentRegistration {
  const meta = (agent.metadata ?? {}) as Record<string, unknown>;
  return {
    name: agent.name,
    framework: agent.framework as AgentRegistration["framework"],
    owner: agent.owner, description: agent.description, version: agent.version,
    channels: agent.channels, tools: agent.tools, permissions: agent.permissions, metadata: agent.metadata,
    hasAuth: meta.hasAuth === true,
    hasGuardrails: meta.hasGuardrails === true,
    hasObservability: meta.hasObservability === true,
    hasAuditLog: meta.hasAuditLog === true,
  };
}

/**
 * Create a governance instance — the main entry point for governance-sdk.
 *
 * @param config - Optional configuration: storage adapter, policy rules, default outcome, remote server
 * @returns A fully-wired governance instance with register, enforce, audit, score, and scoreFleet
 *
 * @example
 * ```ts
 * const gov = createGovernance({
 *   rules: [blockTools(['shell_exec']), requireLevel(2)],
 * });
 * ```
 */
export function createGovernance(config: GovernanceConfig = {}): GovernanceInstance {
  validateRemoteConfig(config.serverUrl, config.apiKey);

  const onAuditError = config.onAuditError;
  const storage = config.storage ?? createMemoryStorage();
  const policies = createPolicyEngine({
    rules: config.rules,
    defaultOutcome: config.defaultOutcome,
  });

  const remote = config.serverUrl
    ? createRemoteEnforcer({
        serverUrl: config.serverUrl,
        apiKey: config.apiKey!,
        timeout: config.timeout,
        maxRetries: config.maxRetries,
        fallbackMode: config.fallbackMode,
      })
    : null;

  // Eval stores — in-memory, capped per agent and total agents
  const evalResultStore = new Map<string, EvalResult[]>();
  const traceCollector = createTraceCollector({ maxTraces: 200 });
  const MAX_EVAL_RESULTS_PER_AGENT = 100;
  const MAX_EVAL_AGENTS = 1000;

  async function register(input: AgentRegistration) {
    if (remote) {
      return remote.register(input);
    }

    const id = crypto.randomUUID();
    const assessment = assessAgent(id, input);

    // Persist capability booleans in metadata so re-scoring can reconstruct them
    const capabilities = {
      hasAuth: input.hasAuth ?? false,
      hasGuardrails: input.hasGuardrails ?? false,
      hasObservability: input.hasObservability ?? false,
      hasAuditLog: input.hasAuditLog ?? false,
    };
    const metadata = { ...input.metadata, ...capabilities };

    const stored = await storage.createAgent({
      id,
      name: input.name,
      framework: input.framework,
      owner: input.owner,
      description: input.description,
      version: input.version ?? "1.0.0",
      channels: input.channels ?? [],
      tools: input.tools ?? [],
      permissions: input.permissions,
      metadata,
      compositeScore: assessment.compositeScore,
      governanceLevel: assessment.level.level,
      status: assessment.status,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    storage.createAuditEvent({
      id: crypto.randomUUID(),
      agentId: id,
      eventType: "agent_registered",
      outcome: "success",
      severity: "info",
      detail: { score: assessment.compositeScore, level: assessment.level.level, status: assessment.status },
      createdAt: new Date().toISOString(),
    }).catch((err: unknown) => { onAuditError?.(err); });

    return { id: stored.id, score: assessment.compositeScore, level: assessment.level.level, status: assessment.status, assessment };
  }

  async function enforce(ctx: EnforcementContext): Promise<EnforcementDecision> {
    if (remote) {
      return remote.enforce(ctx);
    }

    const decision = policies.evaluate(ctx);

    // Audit is off the hot path — fire-and-forget, never blocks enforcement
    storage.createAuditEvent({
      id: crypto.randomUUID(),
      agentId: ctx.agentId,
      eventType: "policy_evaluation",
      outcome: decision.outcome,
      severity: decision.blocked ? "warning" : "info",
      detail: { action: ctx.action, tool: ctx.tool, ruleId: decision.ruleId, reason: decision.reason, rulesEvaluated: decision.rulesEvaluated },
      policyRuleId: decision.ruleId ?? undefined,
      createdAt: new Date().toISOString(),
    }).catch((err: unknown) => { onAuditError?.(err); });

    return decision;
  }

  const audit = {
    async log(event: Omit<AuditEvent, "id" | "createdAt">): Promise<AuditEvent> {
      return storage.createAuditEvent({ ...event, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    },
    async query(filters: AuditQueryFilters): Promise<AuditEvent[]> {
      return storage.queryAuditEvents(filters);
    },
    async count(filters?: AuditQueryFilters): Promise<number> {
      return storage.countAuditEvents(filters);
    },
  };

  async function scoreAgentFn(agentId: string): Promise<GovernanceAssessment | null> {
    const agent = await storage.getAgent(agentId);
    if (!agent) return null;

    const registration = storedToRegistration(agent);
    const assessment = assessAgent(agentId, registration);

    // Apply behavioral adjustments from audit history
    const auditEvents = await storage.queryAuditEvents({ agentId, limit: 200 });
    if (auditEvents.length > 0) {
      const behavioral = computeBehavioralAdjustments({
        events: auditEvents,
        declaredTools: agent.tools,
      });
      assessment.dimensions = applyBehavioralAdjustments(
        assessment.dimensions, behavioral.adjustments,
      );
    }

    // Apply eval adjustments from submitted eval results
    const evalResults = evalResultStore.get(agentId) ?? [];
    if (evalResults.length > 0) {
      const evalAssessment = computeEvalAdjustments({ results: evalResults });
      assessment.dimensions = applyEvalAdjustments(
        assessment.dimensions, evalAssessment.adjustments,
      );
    }

    // Recompute composite score from adjusted dimensions
    const newScore = computeCompositeScore(assessment.dimensions);
    const newLevel = getGovernanceLevel(newScore);
    assessment.compositeScore = newScore;
    assessment.level = newLevel;
    assessment.status = newScore >= 60 ? "approved" : newScore > 0 ? "flagged" : "registered";

    await storage.updateAgent(agentId, {
      compositeScore: newScore,
      governanceLevel: newLevel.level,
      status: assessment.status,
    });
    return assessment;
  }

  async function scoreFleetFn() {
    const agents = await storage.listAgents();
    const registrations = agents.map((a) => ({
      id: a.id,
      registration: storedToRegistration(a),
    }));
    const fleet = assessFleet(registrations);

    // Apply behavioral + eval adjustments to each agent assessment
    for (const assessment of fleet.assessments) {
      const agent = agents.find((a) => a.id === assessment.agentId);
      if (!agent) continue;

      const auditEvents = await storage.queryAuditEvents({ agentId: agent.id, limit: 200 });
      if (auditEvents.length > 0) {
        const behavioral = computeBehavioralAdjustments({
          events: auditEvents,
          declaredTools: agent.tools,
        });
        assessment.dimensions = applyBehavioralAdjustments(
          assessment.dimensions, behavioral.adjustments,
        );
      }

      const evalResults = evalResultStore.get(agent.id) ?? [];
      if (evalResults.length > 0) {
        const evalAssessment = computeEvalAdjustments({ results: evalResults });
        assessment.dimensions = applyEvalAdjustments(
          assessment.dimensions, evalAssessment.adjustments,
        );
      }

      const newScore = computeCompositeScore(assessment.dimensions);
      const newLevel = getGovernanceLevel(newScore);
      assessment.compositeScore = newScore;
      assessment.level = newLevel;
      assessment.status = newScore >= 60 ? "approved" : newScore > 0 ? "flagged" : "registered";
    }

    // Recompute fleet summary with adjusted scores
    const scores = fleet.assessments.map((a) => a.compositeScore);
    const avgScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;
    fleet.summary.averageScore = avgScore;
    fleet.summary.fleetLevel = getGovernanceLevel(avgScore);

    const sorted = [...fleet.assessments].sort((a, b) => b.compositeScore - a.compositeScore);
    fleet.summary.highestScoring = sorted[0]
      ? { name: sorted[0].agentName, score: sorted[0].compositeScore } : null;
    fleet.summary.lowestScoring = sorted.length > 0
      ? { name: sorted[sorted.length - 1].agentName, score: sorted[sorted.length - 1].compositeScore } : null;

    // Recount by status and level
    const byStatus: Record<string, number> = {
      registered: 0, assessed: 0, approved: 0, flagged: 0, deprecated: 0, quarantined: 0,
    };
    const byLevel: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const a of fleet.assessments) {
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      byLevel[a.level.level] = (byLevel[a.level.level] || 0) + 1;
    }
    fleet.summary.byStatus = byStatus as typeof fleet.summary.byStatus;
    fleet.summary.byLevel = byLevel;

    // Update fleet recommendations
    const recs: string[] = [];
    if (byStatus.flagged > 0) recs.push(`${byStatus.flagged} agent(s) below governance threshold — review immediately`);
    if (byLevel[0] > 0) recs.push(`${byLevel[0]} agent(s) at Level 0 (Unregistered) — complete registration`);
    if (avgScore < 60) recs.push("Fleet average below 60 — prioritize governance improvements before scaling");
    fleet.summary.recommendations = recs;

    return fleet;
  }

  async function enforceStage(ctx: EnforcementContext, stage: PolicyStage): Promise<EnforcementDecision> {
    if (remote) return remote.enforce(ctx, stage);

    const decision = policies.evaluateStage(ctx, stage);

    storage.createAuditEvent({
      id: crypto.randomUUID(),
      agentId: ctx.agentId,
      eventType: `policy_evaluation_${stage}`,
      outcome: decision.outcome,
      severity: decision.blocked ? "warning" : "info",
      detail: { action: ctx.action, tool: ctx.tool, ruleId: decision.ruleId, reason: decision.reason, stage },
      policyRuleId: decision.ruleId ?? undefined,
      createdAt: new Date().toISOString(),
    }).catch((err: unknown) => { onAuditError?.(err); });

    return decision;
  }

  const enforcePreprocess = (ctx: EnforcementContext) => enforceStage(ctx, "preprocess");
  const enforcePostprocess = (ctx: EnforcementContext) => enforceStage(ctx, "postprocess");

  // Expose read-only policy view — mutations go through addRule/removeRule
  const readonlyPolicies: ReadonlyPolicyEngine = {
    evaluate: (ctx) => policies.evaluate(ctx),
    evaluateStage: (ctx, stage) => policies.evaluateStage(ctx, stage),
    getRules: (stage?) => policies.getRules(stage),
    get ruleCount() { return policies.ruleCount; },
  };

  function addRule(rule: PolicyRule): void {
    policies.addRule(rule);
  }

  function removeRule(ruleId: string): void {
    policies.removeRule(ruleId);
  }

  const evalApi = {
    submit(result: EvalResult): void {
      if (!evalResultStore.has(result.agentId)) {
        // Evict oldest agent entry when at capacity
        if (evalResultStore.size >= MAX_EVAL_AGENTS) {
          const oldest = evalResultStore.keys().next().value!;
          evalResultStore.delete(oldest);
        }
        evalResultStore.set(result.agentId, []);
      }
      const results = evalResultStore.get(result.agentId)!;
      results.push(result);
      if (results.length > MAX_EVAL_RESULTS_PER_AGENT) {
        results.splice(0, results.length - MAX_EVAL_RESULTS_PER_AGENT);
      }
    },
    getResults(agentId: string): EvalResult[] {
      return evalResultStore.get(agentId) ?? [];
    },
    clear(agentId: string): void {
      evalResultStore.delete(agentId);
    },
    traces: traceCollector,
    async runRedTeam(agentId: string, redTeamConfig?: RedTeamConfig): Promise<RedTeamReport> {
      return runRedTeam(instance, agentId, redTeamConfig);
    },
  };

  const noopStatus = () => ({ connected: true, mode: "local" as const, latencyMs: 0 });

  const instance: GovernanceInstance = {
    register, enforce, enforcePreprocess, enforcePostprocess, audit,
    score: scoreAgentFn, scoreFleet: scoreFleetFn,
    policies: readonlyPolicies, storage, addRule, removeRule,
    eval: evalApi,
    connect: remote ? remote.connect : async () => noopStatus(),
    status: remote ? remote.status : noopStatus,
    waitForApproval: remote
      ? remote.waitForApproval
      : async () => "timeout" as const,
  };

  return instance;
}

// ─── Re-exports ─────────────────────────────────────────────────

export { storedToRegistration };
export { assessAgent, assessFleet, getGovernanceLevel } from "./scorer.js";
export { createPolicyEngine, blockTools, allowOnlyTools, requireApproval, tokenBudget, rateLimit, requireLevel, requireSequence, timeWindow } from "./policy.js";
export type { PolicyRule, PolicyEngine, PolicyAction, PolicyCondition, PolicyOutcome, PolicyStage, EnforcementContext, EnforcementDecision, PolicyEngineConfig, ConditionEvaluator, RegisteredConditionType } from "./policy.js";
export type { AgentRegistration, AgentFramework, AgentStatus, GovernanceAssessment, GovernanceLevel, DimensionResult, ScoreDimension, FleetSummary } from "./types.js";
export { detectInjection, createInjectionGuard, getBuiltinPatterns } from "./injection-detect.js";
export type { InjectionPattern, InjectionCategory, InjectionResult, InjectionDetectorConfig } from "./injection-detect.js";
export { createGovernanceEmitter } from "./events.js";
export { dryRun, fleetDryRun } from "./dry-run.js";
export type { DryRunScenario, DryRunAction, DryRunResult, DryRunDecision, DryRunSummary, DryRunConfig, FleetDryRunResult } from "./dry-run.js";
export { createGovernanceMetrics } from "./metrics.js";
export type { GovernanceMetrics, MetricName, TimingName, MetricLabels, MetricsSnapshot } from "./metrics.js";
export type { GovernanceEmitter, GovernanceEvent, GovernanceEventType, GovernanceEventHandler } from "./events.js";
export { computeSignals, computeBehavioralAdjustments, applyBehavioralAdjustments } from "./behavioral-scorer.js";
export type { BehavioralInput, BehavioralAdjustment, BehavioralAssessment, BehavioralSignals } from "./behavioral-scorer.js";
export { scanRepoContents, scanRepoContentsWithPlugins, SCAN_GLOBS, SCAN_IGNORE } from "./repo-patterns.js";
export type { CapabilityDetection, RepoScanResult, ScanWithPluginsOptions } from "./repo-patterns.js";
export type {
  ScannerPlugin,
  ScannerImport,
  FileResolver,
  ResolvedSource,
  ExpandToolsContext,
} from "./scanner-plugins/types.js";
export { findPackageJsonPaths, detectAgentRoots } from "./monorepo-detect.js";
export type { AgentRoot } from "./monorepo-detect.js";
export { RemoteEnforcementError } from "./remote-enforce.js";
export type { FallbackMode, RemoteStatus } from "./remote-enforce.js";
export { composePolicies, securityBaseline, complianceOverlay, platformDefaults } from "./policy-compose.js";
export type { PolicySet, ConflictStrategy, ComposeConfig, ComposeResult, PolicyConflict } from "./policy-compose.js";
export { getDefaultStage } from "./policy-stage-defaults.js";
export { inputBlocklist, inputLength, inputPattern, networkAllowlist, scopeBoundary, costBudget, concurrentLimit, outputLength, outputPattern, sensitiveDataFilter, maskSensitiveOutput, maskOutputPattern } from "./policy-presets-extended.js";
export { SENSITIVE_PATTERNS, getSensitivePatterns } from "./conditions/sensitive-patterns.js";
export type { SensitivePattern } from "./conditions/sensitive-patterns.js";
export { maskSensitiveData, maskPattern, maskBlocklistTerms } from "./mask.js";
