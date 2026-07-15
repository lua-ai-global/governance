/**
 * PostgreSQL Storage Adapter for governance-sdk.
 *
 * Production-ready persistent storage with automatic table creation.
 * Schema and row mappers are in storage-postgres-schema.ts.
 */

import type { GovernanceStorage, StoredAgent, AuditEvent, AuditQueryFilters, StoredAuditIntegrity } from "./storage.js";
import { getSchemaSQL, getIntegrityMigrationSQL, rowToAgent, rowToEvent, rowToIntegrityFields } from "./storage-postgres-schema.js";
import type { AgentRow, AuditRow } from "./storage-postgres-schema.js";

// ─── Types ──────────────────────────────────────────────────────

/** Minimal pg.PoolClient-compatible interface (a single checked-out connection) */
export interface PgClientLike {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  release(err?: unknown): void;
}

/** Minimal pg.Pool-compatible interface */
export interface PgPoolLike {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  /**
   * Check out a dedicated connection for a transaction. Present on real
   * pg.Pool; optional here so lightweight/mock pools that only implement
   * query() still satisfy the interface (they use the retry fallback).
   */
  connect?(): Promise<PgClientLike>;
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
      // Run base schema, then the integrity migration. Both are idempotent
      // (CREATE/ALTER IF NOT EXISTS). The migration is a no-op on fresh
      // tables created by the new base schema, but keeps 0.11.x deployments
      // upgrading in place without manual DDL.
      p = pool
        .query(getSchemaSQL(prefix))
        .then(() => pool.query(getIntegrityMigrationSQL(prefix)))
        .then(() => {
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
      `INSERT INTO ${prefix}_agents (id,name,framework,owner,description,version,channels,tools,permissions,metadata,composite_score,governance_level,status,organization_id,registered_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [data.id, data.name, data.framework, data.owner, data.description ?? null, data.version, JSON.stringify(data.channels), JSON.stringify(data.tools), data.permissions ? JSON.stringify(data.permissions) : null, data.metadata ? JSON.stringify(data.metadata) : null, data.compositeScore, data.governanceLevel, data.status, data.organizationId ?? null, data.registeredAt, data.updatedAt],
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
      `INSERT INTO ${prefix}_audit_events (id,agent_id,event_type,outcome,severity,detail,policy_rule_id,organization_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [event.id, event.agentId, event.eventType, event.outcome, event.severity, event.detail ? JSON.stringify(event.detail) : null, event.policyRuleId ?? null, event.organizationId ?? null, event.createdAt],
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

  async function createAuditEventWithIntegrity(
    event: AuditEvent,
    integrity: StoredAuditIntegrity,
  ): Promise<AuditEvent> {
    await ensureMigrated();
    // Single INSERT: event + integrity metadata atomically. A failure here
    // persists neither, so the chain never has a half-written row. Note the
    // caller pre-computed the sequence from process-local state, so this path
    // is only safe under a single writer — appendToAuditChain() is the
    // multi-writer-safe entry point and the one createGovernance() prefers.
    await pool.query(auditIntegrityInsertSQL(prefix), auditIntegrityInsertParams(event, integrity));
    return event;
  }

  async function getChainHead(organizationId?: string): Promise<{ sequence: number; hash: string } | null> {
    await ensureMigrated();
    const result = await pool.query<{ integrity_sequence: string | number | null; integrity_hash: string | null }>(
      chainHeadSQL(prefix),
      [organizationId ?? ""],
    );
    return parseChainHeadRow(result.rows[0]);
  }

  async function appendToAuditChain(
    event: AuditEvent,
    computeIntegrity: (
      head: { sequence: number; hash: string } | null,
    ) => Promise<StoredAuditIntegrity>,
  ): Promise<{ event: AuditEvent; integrity: StoredAuditIntegrity }> {
    await ensureMigrated();
    // Preferred path: a real transaction with a per-org advisory lock makes
    // head-read → computeIntegrity → INSERT indivisible across ALL writers,
    // including separate processes sharing this database. The org's chain is
    // serialised only against itself (hashtext(orgKey)), so unrelated orgs
    // proceed in parallel.
    if (typeof pool.connect === "function") {
      const client = await pool.connect();
      try {
        // READ COMMITTED is load-bearing, not cosmetic: the guarantee is that
        // the head SELECT below — run AFTER the advisory lock is granted — sees
        // the prior writer's just-committed row. Under READ COMMITTED each
        // statement takes a fresh snapshot, so it does. Under REPEATABLE READ /
        // SERIALIZABLE the snapshot is fixed at the first statement (before the
        // lock is granted), the head read goes stale, and the same sequence is
        // re-derived → 23505. Pin it so a server/role default can't break us.
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        // pg_advisory_xact_lock auto-releases at COMMIT/ROLLBACK. The two-arg
        // form namespaces the key under AUDIT_CHAIN_LOCK_CLASS so other
        // advisory-lock users of the same database can't contend with us. The
        // org-less chain uses the empty string, matching the
        // COALESCE(organization_id,'') partition of the unique index.
        await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
          AUDIT_CHAIN_LOCK_CLASS,
          event.organizationId ?? "",
        ]);
        const headRes = await client.query<{ integrity_sequence: string | number | null; integrity_hash: string | null }>(
          chainHeadSQL(prefix),
          [event.organizationId ?? ""],
        );
        const head = parseChainHeadRow(headRes.rows[0]);
        const integrity = await computeIntegrity(head);
        await client.query(auditIntegrityInsertSQL(prefix), auditIntegrityInsertParams(event, integrity));
        await client.query("COMMIT");
        client.release();
        return { event, integrity };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
          client.release();
        } catch (rollbackErr) {
          // ROLLBACK failing means the connection is dead or wedged in an
          // aborted transaction — destroy it rather than poison the pool.
          client.release(rollbackErr);
        }
        throw err;
      }
    }

    // Fallback for pools that expose only query() (no transaction handle):
    // read the durable head, compute, INSERT — and on a unique-violation
    // (another writer took the sequence between our read and insert) re-read
    // the fresh head and retry. Correct without a transaction, and the bound
    // is a real guarantee, not a hope: every 23505 means a COMPETITOR
    // committed the sequence we derived, so a writer can lose at most once
    // per concurrent same-org contender — MAX_ATTEMPTS caps how much
    // same-instant contention the path absorbs before surfacing the error.
    // The jittered backoff desynchronises contenders that all read the same
    // head, so later rounds rarely re-collide.
    const MAX_ATTEMPTS = 12;
    for (let attempt = 1; ; attempt++) {
      const head = await getChainHead(event.organizationId);
      const integrity = await computeIntegrity(head);
      try {
        await pool.query(auditIntegrityInsertSQL(prefix), auditIntegrityInsertParams(event, integrity));
        return { event, integrity };
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isUniqueViolation(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(25 * attempt, 250)));
      }
    }
  }

  async function getAuditIntegrity(eventId: string): Promise<StoredAuditIntegrity | null> {
    await ensureMigrated();
    const result = await pool.query<AuditRow>(
      `SELECT integrity_hash, integrity_previous_hash, integrity_sequence, integrity_signed_at FROM ${prefix}_audit_events WHERE id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    if (!row) return null;
    // pg returns BIGINT as string; normalise before handing to the mapper.
    if (typeof row.integrity_sequence === "string") {
      row.integrity_sequence = parseInt(row.integrity_sequence, 10);
    }
    return rowToIntegrityFields(row);
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

  return {
    createAgent,
    getAgent,
    getAgentByName,
    listAgents,
    updateAgent,
    deleteAgent,
    createAuditEvent,
    queryAuditEvents,
    countAuditEvents,
    createAuditEventWithIntegrity,
    appendToAuditChain,
    getChainHead,
    getAuditIntegrity,
    migrate,
    close: () => pool.end(),
  };
}

/** INSERT statement writing an audit event + its integrity columns in one row. */
function auditIntegrityInsertSQL(prefix: string): string {
  return `INSERT INTO ${prefix}_audit_events (id,agent_id,event_type,outcome,severity,detail,policy_rule_id,organization_id,created_at,integrity_hash,integrity_previous_hash,integrity_sequence,integrity_signed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;
}

/** Positional params for auditIntegrityInsertSQL, in column order. */
function auditIntegrityInsertParams(event: AuditEvent, integrity: StoredAuditIntegrity): unknown[] {
  return [
    event.id,
    event.agentId,
    event.eventType,
    event.outcome,
    event.severity,
    event.detail ? JSON.stringify(event.detail) : null,
    event.policyRuleId ?? null,
    event.organizationId ?? null,
    event.createdAt,
    integrity.hash,
    integrity.previousHash,
    integrity.sequence,
    integrity.signedAt,
  ];
}

/**
 * Advisory-lock namespace (int4) for audit-chain appends — the classid of the
 * two-arg pg_advisory_xact_lock form. Arbitrary but fixed: it only has to be
 * distinct from any other advisory-lock user of the same database.
 */
const AUDIT_CHAIN_LOCK_CLASS = 0x67764143;

/** SELECT for the highest-sequence integrity row of one org's chain. */
function chainHeadSQL(prefix: string): string {
  // COALESCE(organization_id,'') is the exact partition of the unique index
  // and the advisory-lock key: NULL and '' orgs are one chain everywhere, so
  // the head read can never disagree with the uniqueness/lock scope. Bind the
  // org-less chain as ''. Matching the index expression also lets this LIMIT 1
  // walk the unique index directly.
  return `SELECT integrity_sequence, integrity_hash FROM ${prefix}_audit_events WHERE integrity_sequence IS NOT NULL AND COALESCE(organization_id, '') = $1 ORDER BY integrity_sequence DESC LIMIT 1`;
}

/** Coerce a chain-head row (pg returns BIGINT as string) into typed head or null. */
function parseChainHeadRow(
  row: { integrity_sequence: string | number | null; integrity_hash: string | null } | undefined,
): { sequence: number; hash: string } | null {
  if (!row || row.integrity_sequence == null || row.integrity_hash == null) return null;
  const sequence = typeof row.integrity_sequence === "string"
    ? parseInt(row.integrity_sequence, 10)
    : row.integrity_sequence;
  return { sequence, hash: row.integrity_hash };
}

/** Postgres unique-violation SQLSTATE — the audit chain's per-org sequence index. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
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
