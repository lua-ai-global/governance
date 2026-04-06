/**
 * PostgreSQL Storage Adapter for governance-sdk.
 *
 * Production-ready persistent storage with automatic table creation.
 * Schema and row mappers are in storage-postgres-schema.ts.
 */

import type { GovernanceStorage, StoredAgent, AuditEvent, AuditQueryFilters } from "./storage.js";
import { getSchemaSQL, rowToAgent, rowToEvent } from "./storage-postgres-schema.js";
import type { AgentRow, AuditRow } from "./storage-postgres-schema.js";

// ─── Types ──────────────────────────────────────────────────────

/** Minimal pg.Pool-compatible interface */
export interface PgPoolLike {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export interface PostgresStorageConfig {
  pool: PgPoolLike;
  tablePrefix?: string;
  autoMigrate?: boolean;
}

export interface PostgresStorage extends GovernanceStorage {
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * In-flight migration promise per (pool, prefix) pair.
 * Serializes CREATE TABLE so concurrent callers for the same pool+prefix don't race
 * and hit "duplicate key pg_type_typname_nsp_index" when creating composite types.
 * Uses a WeakMap keyed by pool object so different pools with the same prefix
 * each run their own migration, and entries are GC'd when the pool is released.
 */
const migrationByPool = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Create a PostgreSQL-backed storage adapter.
 *
 * @param config - Pool instance, optional table prefix, auto-migrate flag
 * @returns A GovernanceStorage with migrate() and close() methods
 *
 * @example
 * ```ts
 * const storage = await createPostgresStorage({
 *   pool: new Pool({ connectionString: process.env.DATABASE_URL }),
 *   autoMigrate: true,
 * });
 * const gov = createGovernance({ storage });
 * ```
 */
export async function createPostgresStorage(
  config: PostgresStorageConfig,
): Promise<PostgresStorage> {
  const { pool } = config;
  const prefix = config.tablePrefix ?? "lua_gov";
  const autoMigrate = config.autoMigrate ?? true;
  let migrated = false;

  async function migrate(): Promise<void> {
    let prefixMap = migrationByPool.get(pool);
    if (!prefixMap) {
      prefixMap = new Map();
      migrationByPool.set(pool, prefixMap);
    }
    let p = prefixMap.get(prefix);
    if (!p) {
      p = pool.query(getSchemaSQL(prefix)).then(() => {
        prefixMap!.delete(prefix);
      });
      prefixMap.set(prefix, p);
    }
    await p;
    migrated = true;
  }

  async function ensureMigrated(): Promise<void> {
    if (!migrated && autoMigrate) await migrate();
  }

  async function createAgent(data: StoredAgent): Promise<StoredAgent> {
    await ensureMigrated();
    await pool.query(
      `INSERT INTO ${prefix}_agents (id,name,framework,owner,description,version,channels,tools,permissions,metadata,composite_score,governance_level,status,registered_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [data.id, data.name, data.framework, data.owner, data.description ?? null, data.version, JSON.stringify(data.channels), JSON.stringify(data.tools), data.permissions ? JSON.stringify(data.permissions) : null, data.metadata ? JSON.stringify(data.metadata) : null, data.compositeScore, data.governanceLevel, data.status, data.registeredAt, data.updatedAt],
    );
    return data;
  }

  async function getAgent(id: string): Promise<StoredAgent | null> {
    await ensureMigrated();
    const result = await pool.query<AgentRow>(`SELECT * FROM ${prefix}_agents WHERE id = $1`, [id]);
    return result.rows[0] ? rowToAgent(result.rows[0]) : null;
  }

  async function getAgentByName(name: string, owner: string): Promise<StoredAgent | null> {
    await ensureMigrated();
    const result = await pool.query<AgentRow>(`SELECT * FROM ${prefix}_agents WHERE name = $1 AND owner = $2 LIMIT 1`, [name, owner]);
    return result.rows[0] ? rowToAgent(result.rows[0]) : null;
  }

  async function listAgents(organizationId?: string): Promise<StoredAgent[]> {
    await ensureMigrated();
    if (organizationId) {
      const result = await pool.query<AgentRow>(`SELECT * FROM ${prefix}_agents WHERE organization_id = $1 ORDER BY registered_at DESC`, [organizationId]);
      return result.rows.map(rowToAgent);
    }
    const result = await pool.query<AgentRow>(`SELECT * FROM ${prefix}_agents ORDER BY registered_at DESC`);
    return result.rows.map(rowToAgent);
  }

  async function updateAgent(id: string, data: Partial<StoredAgent>): Promise<StoredAgent> {
    await ensureMigrated();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    const fieldMap: Record<string, string> = {
      name: "name", framework: "framework", owner: "owner", description: "description",
      version: "version", compositeScore: "composite_score", governanceLevel: "governance_level", status: "status",
    };

    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
      if (jsKey in data) {
        setClauses.push(`${dbCol} = $${paramIdx++}`);
        values.push((data as Record<string, unknown>)[jsKey]);
      }
    }

    for (const jsonKey of ["channels", "tools", "permissions", "metadata"] as const) {
      if (data[jsonKey] !== undefined) {
        setClauses.push(`${jsonKey} = $${paramIdx++}`);
        values.push(JSON.stringify(data[jsonKey]));
      }
    }

    setClauses.push(`updated_at = $${paramIdx++}`);
    values.push(new Date().toISOString());
    values.push(id);

    const result = await pool.query<AgentRow>(
      `UPDATE ${prefix}_agents SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw new Error(`Agent ${id} not found`);
    return rowToAgent(result.rows[0]);
  }

  async function deleteAgent(id: string): Promise<void> {
    await ensureMigrated();
    const result = await pool.query(`DELETE FROM ${prefix}_agents WHERE id = $1`, [id]);
    if (result.rowCount === 0) throw new Error(`Agent ${id} not found`);
  }

  async function createAuditEvent(event: AuditEvent): Promise<AuditEvent> {
    await ensureMigrated();
    await pool.query(
      `INSERT INTO ${prefix}_audit_events (id,agent_id,event_type,outcome,severity,detail,policy_rule_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [event.id, event.agentId, event.eventType, event.outcome, event.severity, event.detail ? JSON.stringify(event.detail) : null, event.policyRuleId ?? null, event.createdAt],
    );
    return event;
  }

  async function queryAuditEvents(filters: AuditQueryFilters): Promise<AuditEvent[]> {
    await ensureMigrated();
    const { clauses, values, paramIdx } = buildAuditWhere(filters);
    let idx = paramIdx;
    let sql = `SELECT * FROM ${prefix}_audit_events ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    if (filters.offset) { sql += ` OFFSET $${idx++}`; values.push(filters.offset); }
    if (filters.limit) { sql += ` LIMIT $${idx++}`; values.push(filters.limit); }
    const result = await pool.query<AuditRow>(sql, values);
    return result.rows.map(rowToEvent);
  }

  async function countAuditEvents(filters?: AuditQueryFilters): Promise<number> {
    await ensureMigrated();
    if (!filters) {
      const result = await pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM ${prefix}_audit_events`);
      return parseInt(result.rows[0].count, 10);
    }
    const { clauses, values } = buildAuditWhere(filters);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM ${prefix}_audit_events ${where}`, values);
    return parseInt(result.rows[0].count, 10);
  }

  if (autoMigrate) await migrate();

  return { createAgent, getAgent, getAgentByName, listAgents, updateAgent, deleteAgent, createAuditEvent, queryAuditEvents, countAuditEvents, migrate, close: () => pool.end() };
}

function buildAuditWhere(filters: AuditQueryFilters): { clauses: string[]; values: unknown[]; paramIdx: number } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;
  if (filters.organizationId) { clauses.push(`organization_id = $${paramIdx++}`); values.push(filters.organizationId); }
  if (filters.agentId) { clauses.push(`agent_id = $${paramIdx++}`); values.push(filters.agentId); }
  if (filters.eventType) { clauses.push(`event_type = $${paramIdx++}`); values.push(filters.eventType); }
  if (filters.outcome) { clauses.push(`outcome = $${paramIdx++}`); values.push(filters.outcome); }
  if (filters.severity) { clauses.push(`severity = $${paramIdx++}`); values.push(filters.severity); }
  if (filters.since) { clauses.push(`created_at >= $${paramIdx++}`); values.push(filters.since); }
  if (filters.until) { clauses.push(`created_at <= $${paramIdx++}`); values.push(filters.until); }
  return { clauses, values, paramIdx };
}
