/**
 * Kill Switch — instant agent shutdown for emergencies.
 *
 * When an agent goes rogue, you need to kill it in one call.
 * The kill switch integrates with the policy engine to block
 * ALL actions from disabled agents, no exceptions.
 *
 * @example
 * ```ts
 * import { createGovernance } from '@lua-ai-global/governance';
 * import { createKillSwitch } from '@lua-ai-global/governance/kill-switch';
 *
 * const gov = createGovernance({ rules: [...] });
 * const killSwitch = createKillSwitch(gov);
 *
 * // Kill a single agent
 * await killSwitch.kill('agent-123', 'Detected unauthorized data access');
 *
 * // Kill ALL agents (fleet-wide emergency)
 * await killSwitch.killAll('Security incident — all agents halted');
 *
 * // Revive when safe
 * await killSwitch.revive('agent-123');
 * ```
 */

import type { GovernanceInstance, AuditEvent } from "./index";
import type { PolicyRule, EnforcementContext } from "./policy";

// ─── Types ──────────────────────────────────────────────────────

export interface KillRecord {
  agentId: string;
  reason: string;
  killedAt: string;
  killedBy?: string;
  /** Whether storage was successfully updated (false = policy rule is authority) */
  storageSynced: boolean;
}

export interface KillSwitch {
  /** Kill a single agent — blocks ALL actions immediately */
  kill: (agentId: string, reason: string, killedBy?: string) => Promise<KillRecord>;
  /** Kill ALL agents fleet-wide */
  killAll: (reason: string, killedBy?: string) => Promise<KillRecord[]>;
  /** Revive a killed agent */
  revive: (agentId: string, reason?: string) => Promise<void>;
  /** Revive all killed agents */
  reviveAll: (reason?: string) => Promise<void>;
  /** Check if an agent is killed */
  isKilled: (agentId: string) => boolean;
  /** Check if fleet-wide kill is active */
  isFleetKilled: () => boolean;
  /** Get all active kill records */
  getKillRecords: () => KillRecord[];
}

// ─── Constants ──────────────────────────────────────────────────

const KILL_SWITCH_RULE_PREFIX = "__kill_switch__";
const FLEET_KILL_RULE_ID = "__kill_switch__fleet__";

// ─── Implementation ─────────────────────────────────────────────

function makeAgentKillRule(agentId: string, reason: string): PolicyRule {
  return {
    id: `${KILL_SWITCH_RULE_PREFIX}${agentId}`,
    name: `Kill switch: ${agentId}`,
    condition: {
      type: "custom",
      evaluate: (ctx: EnforcementContext) => ctx.agentId === agentId,
    },
    outcome: "block",
    reason: `[KILL SWITCH] ${reason}`,
    priority: 999, // highest possible — overrides everything
    enabled: true,
  };
}

function makeFleetKillRule(reason: string): PolicyRule {
  return {
    id: FLEET_KILL_RULE_ID,
    name: "Kill switch: ALL AGENTS",
    condition: {
      type: "custom",
      evaluate: () => true, // matches everything
    },
    outcome: "block",
    reason: `[FLEET KILL SWITCH] ${reason}`,
    priority: 999,
    enabled: true,
  };
}

/**
 * Create a kill switch bound to a governance instance.
 * Injects blocking rules at the highest priority level.
 */
export function createKillSwitch(gov: GovernanceInstance): KillSwitch {
  const killRecords: Map<string, KillRecord> = new Map();
  let fleetKilled = false;

  async function logKillEvent(
    agentId: string,
    eventType: string,
    reason: string,
    killedBy?: string,
  ): Promise<AuditEvent> {
    return gov.audit.log({
      agentId,
      eventType,
      outcome: "kill_switch",
      severity: "critical",
      detail: { reason, killedBy: killedBy ?? "system" },
    });
  }

  async function kill(
    agentId: string,
    reason: string,
    killedBy?: string,
  ): Promise<KillRecord> {
    const rule = makeAgentKillRule(agentId, reason);
    gov.addRule(rule);

    let storageSynced = false;
    try {
      await gov.storage.updateAgent(agentId, { status: "quarantined" });
      storageSynced = true;
    } catch {
      // Agent may not exist in storage — policy rule is the authority
    }

    const record: KillRecord = {
      agentId,
      reason,
      killedAt: new Date().toISOString(),
      killedBy,
      storageSynced,
    };
    killRecords.set(agentId, record);

    await logKillEvent(agentId, "agent_killed", reason, killedBy);
    return record;
  }

  async function killAll(
    reason: string,
    killedBy?: string,
  ): Promise<KillRecord[]> {
    const rule = makeFleetKillRule(reason);
    gov.addRule(rule);
    fleetKilled = true;

    // Kill all registered agents
    const agents = await gov.storage.listAgents();
    const records: KillRecord[] = [];

    for (const agent of agents) {
      let storageSynced = false;
      try {
        await gov.storage.updateAgent(agent.id, { status: "quarantined" });
        storageSynced = true;
      } catch {
        // Policy rule is the authority — storage is informational
      }

      const record: KillRecord = {
        agentId: agent.id,
        reason,
        killedAt: new Date().toISOString(),
        killedBy,
        storageSynced,
      };
      killRecords.set(agent.id, record);
      records.push(record);
    }

    await logKillEvent("__fleet__", "fleet_killed", reason, killedBy);
    return records;
  }

  async function revive(agentId: string, reason?: string): Promise<void> {
    const ruleId = `${KILL_SWITCH_RULE_PREFIX}${agentId}`;
    gov.removeRule(ruleId);
    killRecords.delete(agentId);

    try {
      await gov.storage.updateAgent(agentId, { status: "approved" });
    } catch {
      // Agent may not exist
    }

    await logKillEvent(
      agentId,
      "agent_revived",
      reason ?? "Kill switch deactivated",
    );
  }

  async function reviveAll(reason?: string): Promise<void> {
    // Remove fleet kill rule
    gov.removeRule(FLEET_KILL_RULE_ID);
    fleetKilled = false;

    // Remove individual kill rules
    for (const agentId of killRecords.keys()) {
      gov.removeRule(`${KILL_SWITCH_RULE_PREFIX}${agentId}`);
      try {
        await gov.storage.updateAgent(agentId, { status: "approved" });
      } catch {
        // continue
      }
    }
    killRecords.clear();

    await logKillEvent(
      "__fleet__",
      "fleet_revived",
      reason ?? "Fleet kill switch deactivated",
    );
  }

  function isKilled(agentId: string): boolean {
    return fleetKilled || killRecords.has(agentId);
  }

  function isFleetKilled(): boolean {
    return fleetKilled;
  }

  function getKillRecords(): KillRecord[] {
    return Array.from(killRecords.values());
  }

  return {
    kill,
    killAll,
    revive,
    reviveAll,
    isKilled,
    isFleetKilled,
    getKillRecords,
  };
}
