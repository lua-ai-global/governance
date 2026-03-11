/**
 * Dry Run — test policies against your fleet without enforcing.
 *
 * Essential for CI/CD pipelines, policy reviews, and migration planning.
 * Simulates enforcement against registered agents and returns what
 * WOULD have been blocked, without actually blocking anything.
 */

import type { GovernanceInstance, StoredAgent } from "./index.js";
import type {
  PolicyRule,
  PolicyAction,
  EnforcementDecision,
} from "./policy.js";
import { createPolicyEngine } from "./policy.js";

// ─── Types ──────────────────────────────────────────────────────

export interface DryRunScenario {
  /** Agent to simulate (by ID or name) */
  agentId?: string;
  agentName?: string;
  /** Actions to simulate */
  actions: DryRunAction[];
}

export interface DryRunAction {
  action: PolicyAction;
  tool?: string;
  input?: Record<string, unknown>;
  sessionTokensUsed?: number;
  recentActionCount?: number;
  toolHistory?: string[];
}

export interface DryRunResult {
  agentId: string;
  agentName: string;
  agentLevel: number;
  decisions: DryRunDecision[];
  summary: DryRunSummary;
}

export interface DryRunDecision {
  action: DryRunAction;
  decision: EnforcementDecision;
}

export interface DryRunSummary {
  totalActions: number;
  wouldBlock: number;
  wouldAllow: number;
  wouldRequireApproval: number;
  wouldWarn: number;
  blockRate: number;
  rulesTriggered: string[];
}

export interface DryRunConfig {
  /** Rules to test (defaults to governance instance rules) */
  rules?: PolicyRule[];
  /** Default outcome when no rules match */
  defaultOutcome?: "allow" | "block";
}

export interface FleetDryRunResult {
  results: DryRunResult[];
  fleetSummary: {
    totalAgents: number;
    totalActions: number;
    totalBlocked: number;
    totalAllowed: number;
    blockRate: number;
    agentsAffected: number;
    rulesTriggered: string[];
  };
  testedAt: string;
}

// ─── Dry Run Engine ─────────────────────────────────────────────

/**
 * Run a dry-run simulation against a single agent.
 *
 * Tests policies against a set of actions without modifying state.
 */
export async function dryRun(
  governance: GovernanceInstance,
  scenario: DryRunScenario,
  config: DryRunConfig = {},
): Promise<DryRunResult> {
  // Resolve agent
  let agent: StoredAgent | null = null;

  if (scenario.agentId) {
    agent = await governance.storage.getAgent(scenario.agentId);
  } else if (scenario.agentName) {
    const agents = await governance.storage.listAgents();
    agent = agents.find((a) => a.name === scenario.agentName) ?? null;
  }

  if (!agent) {
    throw new Error(
      `Agent not found: ${scenario.agentId ?? scenario.agentName}`,
    );
  }

  // Create isolated policy engine for dry run
  const engine = config.rules
    ? createPolicyEngine({
        rules: config.rules,
        defaultOutcome: config.defaultOutcome,
      })
    : governance.policies;

  const decisions: DryRunDecision[] = [];
  const rulesTriggered = new Set<string>();
  let wouldBlock = 0;
  let wouldAllow = 0;
  let wouldRequireApproval = 0;
  let wouldWarn = 0;

  for (const action of scenario.actions) {
    const decision = engine.evaluate({
      agentId: agent.id,
      agentName: agent.name,
      agentLevel: agent.governanceLevel,
      action: action.action,
      tool: action.tool,
      input: action.input,
      sessionTokensUsed: action.sessionTokensUsed,
      recentActionCount: action.recentActionCount,
      toolHistory: action.toolHistory,
    });

    decisions.push({ action, decision });

    if (decision.ruleId) {
      rulesTriggered.add(decision.ruleId);
    }

    if (decision.outcome === "require_approval") {
      wouldRequireApproval++;
    } else if (decision.outcome === "block") {
      wouldBlock++;
    } else if (decision.outcome === "warn") {
      wouldWarn++;
    } else {
      wouldAllow++;
    }
  }

  const totalActions = scenario.actions.length;

  return {
    agentId: agent.id,
    agentName: agent.name,
    agentLevel: agent.governanceLevel,
    decisions,
    summary: {
      totalActions,
      wouldBlock,
      wouldAllow,
      wouldRequireApproval,
      wouldWarn,
      blockRate: totalActions > 0 ? wouldBlock / totalActions : 0,
      rulesTriggered: [...rulesTriggered],
    },
  };
}

/**
 * Run a dry-run simulation against the entire fleet.
 *
 * Tests the same set of actions against every registered agent.
 */
export async function fleetDryRun(
  governance: GovernanceInstance,
  actions: DryRunAction[],
  config: DryRunConfig = {},
): Promise<FleetDryRunResult> {
  const agents = await governance.storage.listAgents();
  const results: DryRunResult[] = [];

  for (const agent of agents) {
    const result = await dryRun(
      governance,
      { agentId: agent.id, actions },
      config,
    );
    results.push(result);
  }

  const totalActions = results.reduce(
    (sum, r) => sum + r.summary.totalActions, 0,
  );
  const totalBlocked = results.reduce(
    (sum, r) => sum + r.summary.wouldBlock, 0,
  );
  const totalAllowed = results.reduce(
    (sum, r) => sum + r.summary.wouldAllow, 0,
  );
  const agentsAffected = results.filter(
    (r) => r.summary.wouldBlock > 0,
  ).length;

  const allRules = new Set<string>();
  for (const r of results) {
    for (const rule of r.summary.rulesTriggered) {
      allRules.add(rule);
    }
  }

  return {
    results,
    fleetSummary: {
      totalAgents: agents.length,
      totalActions,
      totalBlocked,
      totalAllowed,
      blockRate: totalActions > 0 ? totalBlocked / totalActions : 0,
      agentsAffected,
      rulesTriggered: [...allRules],
    },
    testedAt: new Date().toISOString(),
  };
}
