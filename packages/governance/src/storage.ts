/**
 * Storage interfaces and in-memory adapter.
 *
 * Defines the GovernanceStorage contract and provides a built-in
 * memory implementation for testing and development.
 */

// ─── Storage Interface ──────────────────────────────────────────

/**
 * Durable integrity metadata written alongside an audit event.
 * Mirrors AuditIntegrity from audit-integrity.ts — redeclared here so
 * storage.ts has no import cycle with audit-integrity.ts.
 */
export interface StoredAuditIntegrity {
  hash: string;
  previousHash: string;
  sequence: number;
  signedAt: string;
}

/** Storage adapter interface — implement this for custom backends. */
export interface GovernanceStorage {
  createAgent(data: StoredAgent): Promise<StoredAgent>;
  getAgent(id: string): Promise<StoredAgent | null>;
  getAgentByName(name: string, owner: string): Promise<StoredAgent | null>;
  listAgents(organizationId?: string): Promise<StoredAgent[]>;
  updateAgent(id: string, data: Partial<StoredAgent>): Promise<StoredAgent>;
  /** Delete an agent by id. Audit events are preserved. Throws if not found. */
  deleteAgent(id: string): Promise<void>;
  createAuditEvent(event: AuditEvent): Promise<AuditEvent>;
  queryAuditEvents(filters: AuditQueryFilters): Promise<AuditEvent[]>;
  countAuditEvents(filters?: AuditQueryFilters): Promise<number>;
  /**
   * Persist an audit event together with its integrity metadata in a single
   * atomic write. Implementations MUST write both or neither — gaps in the
   * chain must not be introduced by a partial failure.
   *
   * Optional: adapters that predate 0.12 may omit this. When absent,
   * createGovernance() falls back to the legacy in-memory integrityIndex
   * path and emits a one-time warning via onAuditError.
   */
  createAuditEventWithIntegrity?(
    event: AuditEvent,
    integrity: StoredAuditIntegrity,
  ): Promise<AuditEvent>;
  /**
   * Return the latest (highest-sequence) integrity record in storage, or null
   * if no chained events exist. Called once at createGovernance() startup to
   * resume the chain across process restarts.
   */
  getChainHead?(): Promise<{
    sequence: number;
    hash: string;
  } | null>;
  /**
   * Fetch the stored integrity record for a specific event id. Used by
   * integrityChain.export() and verifyAuditIntegrity() to rebuild the chain
   * from durable state instead of in-memory.
   */
  getAuditIntegrity?(eventId: string): Promise<StoredAuditIntegrity | null>;
}

/** Persisted agent record */
export interface StoredAgent {
  id: string;
  name: string;
  framework: string;
  owner: string;
  description?: string;
  version: string;
  channels: string[];
  tools: string[];
  permissions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  compositeScore: number;
  governanceLevel: number;
  status: string;
  registeredAt: string;
  updatedAt: string;
  /** Organization ID for multi-tenant isolation */
  organizationId?: string;
}

import type { PolicyOutcome } from "./policy.js";

/** All valid audit event outcome values — PolicyOutcome + plugin/system outcomes */
export type AuditOutcome = PolicyOutcome | "success" | "failure" | "kill_switch";

/** Audit event record */
export interface AuditEvent {
  id: string;
  agentId: string;
  eventType: string;
  outcome: AuditOutcome;
  severity: string;
  detail?: Record<string, unknown>;
  policyRuleId?: string;
  createdAt: string;
  /** Organization ID for multi-tenant isolation */
  organizationId?: string;
}

/** Filters for querying audit events */
export interface AuditQueryFilters {
  agentId?: string;
  eventType?: string;
  outcome?: string;
  severity?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  /** Filter by organization ID for multi-tenant isolation */
  organizationId?: string;
}

// ─── Memory Storage ─────────────────────────────────────────────

/**
 * Create an in-memory storage adapter.
 * Useful for testing, development, and quick prototyping.
 * Data is lost when the process exits.
 */
const MAX_AUDIT_EVENTS = 10_000;

export function createMemoryStorage(): GovernanceStorage {
  const agents: Map<string, StoredAgent> = new Map();
  const events: AuditEvent[] = [];
  const integrity: Map<string, StoredAuditIntegrity> = new Map();
  let chainHead: { sequence: number; hash: string } | null = null;

  return {
    async createAgent(data) {
      agents.set(data.id, data);
      return data;
    },
    async getAgent(id) {
      return agents.get(id) ?? null;
    },
    async getAgentByName(name, owner) {
      for (const a of agents.values()) {
        if (a.name === name && a.owner === owner) return a;
      }
      return null;
    },
    async listAgents(organizationId?: string) {
      const all = Array.from(agents.values());
      if (organizationId) return all.filter((a) => a.organizationId === organizationId);
      return all;
    },
    async updateAgent(id, data) {
      const existing = agents.get(id);
      if (!existing) throw new Error(`Agent ${id} not found`);
      const updated = { ...existing, ...data, updatedAt: new Date().toISOString() };
      agents.set(id, updated);
      return updated;
    },
    async deleteAgent(id) {
      if (!agents.has(id)) throw new Error(`Agent ${id} not found`);
      agents.delete(id);
    },
    async createAuditEvent(event) {
      events.push(event);
      // Evict oldest events when exceeding capacity
      if (events.length > MAX_AUDIT_EVENTS) {
        events.splice(0, events.length - MAX_AUDIT_EVENTS);
      }
      return event;
    },
    async queryAuditEvents(filters) {
      let result = [...events];
      if (filters.organizationId) result = result.filter((e) => e.organizationId === filters.organizationId);
      if (filters.agentId) result = result.filter((e) => e.agentId === filters.agentId);
      if (filters.eventType) result = result.filter((e) => e.eventType === filters.eventType);
      if (filters.outcome) result = result.filter((e) => e.outcome === filters.outcome);
      if (filters.severity) result = result.filter((e) => e.severity === filters.severity);
      if (filters.since) result = result.filter((e) => e.createdAt >= filters.since!);
      if (filters.until) result = result.filter((e) => e.createdAt <= filters.until!);
      result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (filters.offset) result = result.slice(filters.offset);
      if (filters.limit) result = result.slice(0, filters.limit);
      return result;
    },
    async countAuditEvents(filters) {
      if (!filters) return events.length;
      const result = await this.queryAuditEvents({ ...filters, limit: undefined, offset: undefined });
      return result.length;
    },
    async createAuditEventWithIntegrity(event, integrityMeta) {
      // Atomic: push both records in the same microtask. The memory adapter
      // is single-threaded per event loop tick, so this is trivially atomic;
      // the contract matters for Postgres where it becomes a single INSERT.
      events.push(event);
      if (events.length > MAX_AUDIT_EVENTS) {
        const dropped = events.splice(0, events.length - MAX_AUDIT_EVENTS);
        for (const d of dropped) integrity.delete(d.id);
      }
      integrity.set(event.id, integrityMeta);
      if (!chainHead || integrityMeta.sequence > chainHead.sequence) {
        chainHead = { sequence: integrityMeta.sequence, hash: integrityMeta.hash };
      }
      return event;
    },
    async getChainHead() {
      return chainHead ? { ...chainHead } : null;
    },
    async getAuditIntegrity(eventId) {
      const meta = integrity.get(eventId);
      return meta ? { ...meta } : null;
    },
  };
}
