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
import {
  canonicalize as canonicalizeAuditEvent,
  hmacSha256,
  GENESIS_HASH,
  type AuditIntegrity,
  type IntegrityAuditEvent,
} from "./audit-integrity.js";
import type { AgentRegistration, GovernanceAssessment, FleetSummary } from "./types.js";
import type { PolicyRule, PolicyEngine, PolicyStage, EnforcementContext, EnforcementDecision } from "./policy.js";
import type { GovernanceStorage, StoredAgent, AuditEvent, AuditQueryFilters } from "./storage.js";

/**
 * Post-execution outcome payload for `gov.recordOutcome()`. Framework
 * adapters build this after a tool / LLM / governed-action returns and
 * pass it back so the audit chain covers "decision → outcome."
 */
export interface ActionOutcome {
  agentId: string;
  /** The tool / action that ran — matches what was on the EnforcementContext. */
  tool?: string;
  action?: string;
  /** Whether the action succeeded without throwing. */
  success: boolean;
  /** Wall-clock duration in ms. */
  durationMs?: number;
  /** Output summary — callers should redact sensitive content before passing. */
  output?: unknown;
  /** Error message if `success === false`. */
  error?: string;
  /** Tokens consumed by the action (LLM calls). */
  tokensUsed?: number;
  /** Optional ruleId that the preceding enforce() matched, to link the outcome back to the decision. */
  policyRuleId?: string;
  /** Optional extra fields. */
  detail?: Record<string, unknown>;
}

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
  /**
   * Wire tamper-evident (HMAC-SHA256 hash-chained) audit into EVERY event
   * the SDK writes — registrations, enforce decisions, `audit.log()` calls,
   * `recordOutcome()` calls, kill-switch events. When set, every write is
   * intercepted and appended to a signed chain that `verifyAuditIntegrity`
   * can re-check offline.
   *
   * Honesty notes:
   *  - Only events routed through THIS governance instance get chained.
   *    Host-level logging your app does independently is not covered.
   *  - Plain HMAC is tamper-evident to holders of the signing secret;
   *    if the secret leaks, history is rewritable. Rotate + pair with an
   *    external anchor for defence-in-depth.
   */
  integrityAudit?: {
    /** HMAC secret. Rotate regularly. */
    signingKey: string;
    /**
     * What to do when a chain write fails (storage down, async contention):
     *  - `"allow"` (default) — log via `onAuditError`, proceed anyway. Chain
     *    may have a gap; `verifyAuditIntegrity` will detect it.
     *  - `"block"` — throw from `enforce()` so the decision is NOT applied.
     *    Guarantees no gaps at the cost of availability.
     */
    onFailure?: "allow" | "block";
  };
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
  /**
   * Evaluate only tool_result-stage rules.
   *
   * The `tool_result` stage runs after a tool returns and before the LLM
   * ingests the result on the next turn. Use this when you've intercepted
   * a tool's output (e.g. via wrapTool() or the MCP adapter) and want
   * stage-scoped enforcement on the returned content.
   *
   * For most callers, prefer `scanToolResult()` from `tool-result-scan.ts`
   * — it does the signal generation (detectInjection → mlInjectionScore)
   * and field extraction in addition to calling this method.
   */
  enforceToolResult: (ctx: EnforcementContext) => Promise<EnforcementDecision>;
  /** Evaluate only postprocess-stage rules */
  enforcePostprocess: (ctx: EnforcementContext) => Promise<EnforcementDecision>;
  /**
   * Record what actually happened AFTER an enforce()-approved action ran.
   * Framework adapters call this after the tool/LLM invocation returns so
   * the audit chain covers "decision → outcome," not just the decision.
   *
   * Safe to call even when `integrityAudit` isn't configured — the event
   * is written to plain storage. When integrity IS on, it's HMAC-chained
   * alongside everything else.
   *
   * Marked optional on the type for backwards compatibility with 0.10.x
   * consumers who implemented `GovernanceInstance` by hand (e.g. in test
   * mocks). Always populated by `createGovernance()` at runtime.
   */
  recordOutcome?: (outcome: ActionOutcome) => Promise<AuditEvent>;
  /**
   * Integrity-audit helpers. Only populated when `integrityAudit` is
   * configured on createGovernance(). Exports the signed chain for
   * offline verification via `verifyAuditIntegrity`.
   */
  integrityChain?: {
    /** Export the full chain (or a filtered slice) as IntegrityAuditEvent[]. */
    export: (filters?: AuditQueryFilters) => Promise<IntegrityAuditEvent[]>;
    /** Chain stats: latest sequence, latest hash, algorithm. */
    stats: () => { latestSequence: number; latestHash: string; algorithm: string };
  };
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

  // ── Integrity audit chain (opt-in) ───────────────────────────
  //
  // When `integrityAudit` is configured, every write routed through
  // `writeAudit()` gets HMAC-SHA256 hash-chained. The chain state
  // (sequence, last hash, per-event integrity) is persisted to durable
  // storage through GovernanceStorage.createAuditEventWithIntegrity() so
  // the chain survives process restarts. Chain resume on boot is handled
  // by loadChainHead() below.
  //
  // Serialisation via `chainLock` prevents concurrent writes from forking
  // the chain within a single process. Cross-process safety is provided
  // by the UNIQUE index on integrity_sequence at the storage layer.
  const integrity = config.integrityAudit;
  let chainLastHash = GENESIS_HASH;
  let chainSequence = 0;
  let chainLock: Promise<unknown> = Promise.resolve();
  // Fallback in-memory index for adapters that don't implement
  // createAuditEventWithIntegrity (e.g. third-party 0.11.x adapters).
  // When the storage adapter IS integrity-aware, we don't populate this
  // map — reads go back to storage.getAuditIntegrity().
  const integrityIndex = new Map<string, AuditIntegrity>();
  const storageHasIntegrity =
    typeof storage.createAuditEventWithIntegrity === "function" &&
    typeof storage.getAuditIntegrity === "function";
  let chainHeadLoaded = false;
  let chainHeadLoadPromise: Promise<void> | null = null;

  async function loadChainHead(): Promise<void> {
    if (chainHeadLoaded || !integrity) return;
    if (chainHeadLoadPromise) return chainHeadLoadPromise;
    chainHeadLoadPromise = (async () => {
      if (typeof storage.getChainHead === "function") {
        const head = await storage.getChainHead();
        if (head) {
          chainLastHash = head.hash;
          chainSequence = head.sequence;
        }
      }
      chainHeadLoaded = true;
    })();
    return chainHeadLoadPromise;
  }

  async function writeAudit(
    event: Omit<AuditEvent, "id" | "createdAt">,
  ): Promise<AuditEvent> {
    const full: AuditEvent = {
      ...event,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    if (!integrity) {
      // Plain path — as before.
      return storage.createAuditEvent(full);
    }

    // Chained path. Serialise via chainLock so sequence is race-free.
    // On failure we preserve the chainLastHash/chainSequence (don't bump)
    // so the next write attempts the same slot — avoids silent gaps.
    const result = chainLock.then(async () => {
      // First call after boot: resume chain from durable state, if any.
      if (!chainHeadLoaded) await loadChainHead();

      const previousHash = chainLastHash;
      const nextSequence = chainSequence + 1;
      const canonical = canonicalizeAuditEvent(full, previousHash, nextSequence);
      const hash = await hmacSha256(integrity.signingKey, canonical);
      const integrityMeta: AuditIntegrity = {
        hash,
        previousHash,
        sequence: nextSequence,
        signedAt: new Date().toISOString(),
      };

      let stored: AuditEvent;
      if (storageHasIntegrity) {
        // Durable path: integrity columns written in the same INSERT as
        // the event. Restart-safe — getChainHead() will find this row.
        stored = await storage.createAuditEventWithIntegrity!(full, integrityMeta);
      } else {
        // Legacy path: adapter predates 0.12. Event persists, integrity
        // lives only in this process's integrityIndex. A process restart
        // will leave earlier events unverifiable. This is a downgrade,
        // not the default; surfaced via onAuditError below.
        stored = await storage.createAuditEvent(full);
        integrityIndex.set(full.id, integrityMeta);
        onAuditError?.(
          new Error(
            "integrity chain: storage adapter does not implement createAuditEventWithIntegrity; chain is session-local only and will not survive process restart",
          ),
        );
      }
      chainLastHash = hash;
      chainSequence = nextSequence;
      return stored;
    });

    chainLock = result.catch(() => {
      /* lock must advance even on failure */
    });

    return result; // throws on failure — callers decide policy
  }

  const remote = config.serverUrl
    ? createRemoteEnforcer({
        serverUrl: config.serverUrl,
        apiKey: config.apiKey!,
        timeout: config.timeout,
        maxRetries: config.maxRetries,
        fallbackMode: config.fallbackMode,
      })
    : null;

  async function register(input: AgentRegistration) {
    if (remote) {
      return remote.register(input);
    }

    // Honor a caller-supplied id when present (e.g. binding to a Lua
    // agent's canonical agentId from lua.skill.yaml so the dashboard
    // record uses the same id the runtime will send to enforce()).
    const id = input.id ?? crypto.randomUUID();
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

    // With integrity on, await the chain write so sequence ordering is
    // deterministic (and fail-closed mode can reject). Without integrity,
    // fire-and-forget for the legacy behaviour.
    const regWrite = writeAudit({
      agentId: id,
      eventType: "agent_registered",
      outcome: "success",
      severity: "info",
      detail: { score: assessment.compositeScore, level: assessment.level.level, status: assessment.status },
    });
    if (integrity) {
      try { await regWrite; } catch (err) { onAuditError?.(err); if (integrity.onFailure === "block") throw err; }
    } else {
      regWrite.catch((err: unknown) => { onAuditError?.(err); });
    }

    return { id: stored.id, score: assessment.compositeScore, level: assessment.level.level, status: assessment.status, assessment };
  }

  async function enforce(ctx: EnforcementContext): Promise<EnforcementDecision> {
    if (remote) {
      return remote.enforce(ctx);
    }

    const decision = policies.evaluate(ctx);

    // When integrityAudit is configured, we AWAIT the chain write so
    // sequencing is deterministic (and onFailure:"block" can veto the
    // decision). Without integrity, keep the legacy fire-and-forget path
    // to stay off the hot path.
    const writePromise = writeAudit({
      agentId: ctx.agentId,
      eventType: "policy_evaluation",
      outcome: decision.outcome,
      severity: decision.blocked ? "warning" : "info",
      detail: { action: ctx.action, tool: ctx.tool, ruleId: decision.ruleId, reason: decision.reason, rulesEvaluated: decision.rulesEvaluated },
      policyRuleId: decision.ruleId ?? undefined,
    });
    if (integrity) {
      try {
        await writePromise;
      } catch (err) {
        onAuditError?.(err);
        if (integrity.onFailure === "block") throw err;
      }
    } else {
      writePromise.catch((err: unknown) => { onAuditError?.(err); });
    }

    return decision;
  }

  const audit = {
    async log(event: Omit<AuditEvent, "id" | "createdAt">): Promise<AuditEvent> {
      return writeAudit(event);
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

    // Apply behavioral adjustments to each agent assessment
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

    const writePromise = writeAudit({
      agentId: ctx.agentId,
      eventType: `policy_evaluation_${stage}`,
      outcome: decision.outcome,
      severity: decision.blocked ? "warning" : "info",
      detail: { action: ctx.action, tool: ctx.tool, ruleId: decision.ruleId, reason: decision.reason, stage },
      policyRuleId: decision.ruleId ?? undefined,
    });
    if (integrity) {
      try {
        await writePromise;
      } catch (err) {
        onAuditError?.(err);
        if (integrity.onFailure === "block") throw err;
      }
    } else {
      writePromise.catch((err: unknown) => { onAuditError?.(err); });
    }

    return decision;
  }

  const enforcePreprocess = (ctx: EnforcementContext) => enforceStage(ctx, "preprocess");
  const enforceToolResult = (ctx: EnforcementContext) => enforceStage(ctx, "tool_result");
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

  const noopStatus = () => ({ connected: true, mode: "local" as const, latencyMs: 0 });

  const integrityChain = integrity
    ? {
        async export(filters?: AuditQueryFilters): Promise<IntegrityAuditEvent[]> {
          // Ensure boot-time resume has run so stats()/export() reflect
          // durable state even if no writes have happened yet.
          if (!chainHeadLoaded) await loadChainHead();
          const events = await storage.queryAuditEvents({
            ...filters,
            limit: undefined,
            offset: undefined,
          });
          const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          const result: IntegrityAuditEvent[] = [];
          for (const e of sorted) {
            // Prefer durable integrity record; fall back to in-memory
            // index for adapters that don't yet persist it.
            const durable = storageHasIntegrity
              ? await storage.getAuditIntegrity!(e.id)
              : null;
            const meta = durable ?? integrityIndex.get(e.id);
            if (meta) result.push({ ...e, integrity: meta });
          }
          return result;
        },
        stats() {
          return {
            latestSequence: chainSequence,
            latestHash: chainLastHash,
            algorithm: "hmac-sha256",
          };
        },
      }
    : undefined;

  async function recordOutcome(outcome: ActionOutcome): Promise<AuditEvent> {
    return writeAudit({
      agentId: outcome.agentId,
      eventType: "action_outcome",
      outcome: outcome.success ? "success" : "failure",
      severity: outcome.success ? "info" : "warning",
      detail: {
        tool: outcome.tool,
        action: outcome.action,
        durationMs: outcome.durationMs,
        tokensUsed: outcome.tokensUsed,
        error: outcome.error,
        output: outcome.output,
        ...(outcome.detail ?? {}),
      },
      policyRuleId: outcome.policyRuleId,
    });
  }

  const instance: GovernanceInstance = {
    register, enforce, enforcePreprocess, enforceToolResult, enforcePostprocess, audit,
    recordOutcome,
    score: scoreAgentFn, scoreFleet: scoreFleetFn,
    policies: readonlyPolicies, storage, addRule, removeRule,
    connect: remote ? remote.connect : async () => noopStatus(),
    status: remote ? remote.status : noopStatus,
    waitForApproval: remote
      ? remote.waitForApproval
      : async () => "timeout" as const,
    ...(integrityChain ? { integrityChain } : {}),
  };

  return instance;
}

// ─── Re-exports ─────────────────────────────────────────────────

export { storedToRegistration };
export { assessAgent, assessFleet, getGovernanceLevel } from "./scorer.js";
export { createPolicyEngine, blockTools, allowOnlyTools, requireApproval, tokenBudget, rateLimit, requireLevel, requireSignedIdentity, requireSequence, timeWindow } from "./policy.js";
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
export { mlInjectionGuard } from "./policy-presets.js";
export { runWithOutcome } from "./action-recorder.js";
export type { RunWithOutcomeOptions } from "./action-recorder.js";
export { scanToolResult, extractScannableText } from "./tool-result-scan.js";
export type { ScanToolResultInput, ScanToolResultOutput, BlockedToolResult } from "./tool-result-scan.js";
export { SENSITIVE_PATTERNS, getSensitivePatterns } from "./conditions/sensitive-patterns.js";
export type { SensitivePattern } from "./conditions/sensitive-patterns.js";
export { maskSensitiveData, maskPattern, maskBlocklistTerms } from "./mask.js";
