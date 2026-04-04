/**
 * Storage interfaces and in-memory adapter.
 *
 * Defines the GovernanceStorage contract and provides a built-in
 * memory implementation for testing and development.
 */

// ─── Storage Interface ──────────────────────────────────────────

/** Storage adapter interface — implement this for custom backends. */
export interface GovernanceStorage {
  createAgent(data: StoredAgent): Promise<StoredAgent>;
  getAgent(id: string): Promise<StoredAgent | null>;
  getAgentByName(name: string, owner: string): Promise<StoredAgent | null>;
  listAgents(organizationId?: string): Promise<StoredAgent[]>;
  updateAgent(id: string, data: Partial<StoredAgent>): Promise<StoredAgent>;
  createAuditEvent(event: AuditEvent): Promise<AuditEvent>;
  queryAuditEvents(filters: AuditQueryFilters): Promise<AuditEvent[]>;
  countAuditEvents(filters?: AuditQueryFilters): Promise<number>;
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
  };
}
