/**
 * PostgreSQL schema, row types, and mappers for governance storage.
 * Separated from storage-postgres.ts to keep files under 300 LOC.
 */

import type { StoredAgent, AuditEvent } from "./storage.js";
import type { AuditIntegrity } from "./audit-integrity.js";

// ─── Schema SQL ─────────────────────────────────────────────────

export function getSchemaSQL(prefix: string): string {
  // Sanitize prefix to prevent SQL injection — only allow alphanumeric + underscore
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) {
    throw new Error(`Invalid table prefix: "${prefix}" — must be alphanumeric/underscore only`);
  }
  return `
    CREATE TABLE IF NOT EXISTS ${prefix}_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      framework TEXT NOT NULL,
      owner TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL DEFAULT '1.0.0',
      channels JSONB NOT NULL DEFAULT '[]',
      tools JSONB NOT NULL DEFAULT '[]',
      permissions JSONB,
      metadata JSONB,
      composite_score REAL NOT NULL DEFAULT 0,
      governance_level INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'registered',
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${prefix}_audit_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      detail JSONB,
      policy_rule_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_${prefix}_audit_agent_id
      ON ${prefix}_audit_events (agent_id);

    CREATE INDEX IF NOT EXISTS idx_${prefix}_audit_event_type
      ON ${prefix}_audit_events (event_type);

    CREATE INDEX IF NOT EXISTS idx_${prefix}_audit_created_at
      ON ${prefix}_audit_events (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_${prefix}_agents_name_owner
      ON ${prefix}_agents (name, owner);
  `;
}

// ─── Row Types ──────────────────────────────────────────────────

export interface AgentRow {
  id: string;
  name: string;
  framework: string;
  owner: string;
  description: string | null;
  version: string;
  channels: string[];
  tools: string[];
  permissions: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  composite_score: number;
  governance_level: number;
  status: string;
  registered_at: string | Date;
  updated_at: string | Date;
}

export interface AuditRow {
  id: string;
  agent_id: string;
  event_type: string;
  outcome: string;
  severity: string;
  detail: Record<string, unknown> | null;
  policy_rule_id: string | null;
  created_at: string | Date;
  integrity_hash?: string | null;
  integrity_previous_hash?: string | null;
  integrity_sequence?: number | null;
  integrity_signed_at?: string | Date | null;
}

// ─── Row Mappers ────────────────────────────────────────────────

function toISOString(val: string | Date): string {
  if (val instanceof Date) return val.toISOString();
  return val;
}

export function rowToAgent(row: AgentRow): StoredAgent {
  return {
    id: row.id,
    name: row.name,
    framework: row.framework,
    owner: row.owner,
    description: row.description ?? undefined,
    version: row.version,
    channels: Array.isArray(row.channels) ? row.channels : [],
    tools: Array.isArray(row.tools) ? row.tools : [],
    permissions: row.permissions ?? undefined,
    metadata: row.metadata ?? undefined,
    compositeScore: row.composite_score,
    governanceLevel: row.governance_level,
    status: row.status,
    registeredAt: toISOString(row.registered_at),
    updatedAt: toISOString(row.updated_at),
  };
}

export function rowToEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    agentId: row.agent_id,
    eventType: row.event_type,
    outcome: row.outcome,
    severity: row.severity,
    detail: row.detail ?? undefined,
    policyRuleId: row.policy_rule_id ?? undefined,
    createdAt: toISOString(row.created_at),
  };
}

// ─── Integrity Migration ────────────────────────────────────────

/** DDL to add integrity columns to an existing audit_events table */
export function getIntegrityMigrationSQL(prefix: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) {
    throw new Error(`Invalid table prefix: "${prefix}" — must be alphanumeric/underscore only`);
  }
  return `
    ALTER TABLE ${prefix}_audit_events ADD COLUMN IF NOT EXISTS integrity_hash TEXT;
    ALTER TABLE ${prefix}_audit_events ADD COLUMN IF NOT EXISTS integrity_previous_hash TEXT;
    ALTER TABLE ${prefix}_audit_events ADD COLUMN IF NOT EXISTS integrity_sequence INTEGER;
    ALTER TABLE ${prefix}_audit_events ADD COLUMN IF NOT EXISTS integrity_signed_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_audit_integrity_seq
      ON ${prefix}_audit_events (integrity_sequence) WHERE integrity_sequence IS NOT NULL;
  `;
}

/** Extract integrity fields from a DB row, or null if not present */
export function rowToIntegrityFields(row: AuditRow): AuditIntegrity | null {
  if (
    row.integrity_hash == null ||
    row.integrity_previous_hash == null ||
    row.integrity_sequence == null ||
    row.integrity_signed_at == null
  ) {
    return null;
  }
  return {
    hash: row.integrity_hash,
    previousHash: row.integrity_previous_hash,
    sequence: row.integrity_sequence,
    signedAt: toISOString(row.integrity_signed_at),
  };
}
