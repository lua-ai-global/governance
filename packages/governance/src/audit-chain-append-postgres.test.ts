/**
 * Postgres adapter — atomic appendToAuditChain.
 *
 * Exercises the adapter's transactional path (BEGIN → pg_advisory_xact_lock →
 * SELECT head → INSERT → COMMIT) and its retry fallback for pools without a
 * transaction handle.
 *
 * NOTE ON FIDELITY: the mock models `pg_advisory_xact_lock` as an in-process
 * async mutex over a shared rows array, so it reproduces the SERIALISATION the
 * lock provides and lets us assert the orchestration end-to-end. It does NOT
 * prove Postgres itself serialises across real connections — that is a Postgres
 * guarantee, not something a mock can establish. Two assertions here are
 * therefore split: (1) SQL SHAPE — the exact statement sequence the adapter
 * emits; (2) ORCHESTRATION — contiguous sequences under the modelled lock.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStorage } from "./storage-postgres";
import type { PgPoolLike, PgClientLike } from "./storage-postgres";
import { createGovernance } from "./index";
import { verifyAuditIntegrity } from "./audit-integrity-verify";

const KEY = "pg-append-secret";

interface AuditRowShape {
  organization_id: string | null;
  integrity_sequence: number;
  integrity_hash: string;
  [k: string]: unknown;
}

/**
 * Postgres pool mock with a working `connect()`, an in-process advisory-lock
 * mutex, a shared audit table, and the per-org unique (org, sequence) index.
 */
function createTxnPool(opts: { clientLog?: string[] } = {}): PgPoolLike {
  const rows: AuditRowShape[] = [];
  const locks = new Map<string, Promise<void>>();
  const orgKey = (org: string | null | undefined) => org ?? "";

  function headFor(org: string | null): { rows: unknown[] } {
    const matching = rows.filter((r) => orgKey(r.organization_id) === orgKey(org));
    if (matching.length === 0) return { rows: [] };
    const top = matching.reduce((a, b) => (b.integrity_sequence > a.integrity_sequence ? b : a));
    return { rows: [{ integrity_sequence: top.integrity_sequence, integrity_hash: top.integrity_hash }] };
  }

  function insert(values: unknown[]): void {
    // Column order from auditIntegrityInsertSQL.
    const org = values[7] as string | null;
    const sequence = values[11] as number;
    if (rows.some((r) => orgKey(r.organization_id) === orgKey(org) && r.integrity_sequence === sequence)) {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    }
    rows.push({
      id: values[0] as string,
      agent_id: values[1],
      event_type: values[2],
      outcome: values[3],
      severity: values[4],
      detail: values[5] != null ? JSON.parse(values[5] as string) : null,
      policy_rule_id: values[6],
      organization_id: org,
      created_at: values[8],
      integrity_hash: values[9] as string,
      integrity_previous_hash: values[10],
      integrity_sequence: sequence,
      integrity_signed_at: values[12],
    });
  }

  async function runQuery(text: string, values: unknown[] | undefined, log?: string[]) {
    const t = text.trim();
    if (log) log.push(t.split(/\s+/).slice(0, 2).join(" "));
    if (t.startsWith("BEGIN") || t.startsWith("COMMIT") || t.startsWith("ROLLBACK")) {
      return { rows: [], rowCount: 0 };
    }
    if (t.includes("CREATE TABLE") || t.includes("CREATE INDEX") || t.includes("ALTER TABLE") || t.includes("DROP INDEX")) {
      return { rows: [], rowCount: 0 };
    }
    if (t.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 0 }; // handled by the client wrapper
    }
    if (t.startsWith("SELECT") && t.includes("integrity_sequence IS NOT NULL")) {
      return headFor((values?.[0] as string) ?? null) as { rows: never[]; rowCount: number };
    }
    // getAuditIntegrity(eventId): SELECT integrity_* ... WHERE id = $1
    if (t.startsWith("SELECT integrity_hash")) {
      const row = rows.find((r) => r.id === values?.[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as { rows: never[]; rowCount: number };
    }
    // queryAuditEvents: SELECT * FROM ... [WHERE organization_id = $1] ORDER BY created_at DESC
    if (t.startsWith("SELECT * FROM")) {
      const org = t.includes("organization_id = $1") ? (values?.[0] as string) : undefined;
      const out = (org !== undefined ? rows.filter((r) => r.organization_id === org) : [...rows]);
      return { rows: out, rowCount: out.length } as unknown as { rows: never[]; rowCount: number };
    }
    if (t.startsWith("INSERT")) {
      insert(values ?? []);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return {
    async query(text: string, values?: unknown[]) {
      return runQuery(text, values) as never;
    },
    async connect(): Promise<PgClientLike> {
      let releaseLock: (() => void) | null = null;
      const log = opts.clientLog;
      return {
        async query(text: string, values?: unknown[]) {
          const t = text.trim();
          if (t.includes("pg_advisory_xact_lock")) {
            // Two-arg form: values[0] = lock classid, values[1] = org key.
            const key = orgKey(values?.[1] as string);
            const prev = locks.get(key) ?? Promise.resolve();
            let resolveMine!: () => void;
            const mine = new Promise<void>((r) => { resolveMine = r; });
            locks.set(key, prev.then(() => mine));
            await prev; // block until the previous holder releases
            releaseLock = resolveMine;
            if (log) log.push("SELECT pg_advisory_xact_lock");
            return { rows: [], rowCount: 0 } as never;
          }
          const res = await runQuery(text, values, log);
          if (t.startsWith("COMMIT") || t.startsWith("ROLLBACK")) {
            releaseLock?.();
            releaseLock = null;
          }
          return res as never;
        },
        release() {
          // Safety net: release the lock if COMMIT/ROLLBACK didn't run.
          releaseLock?.();
          releaseLock = null;
        },
      };
    },
    async end() {},
  };
}

describe("postgres appendToAuditChain — transactional path", () => {
  it("emits BEGIN → advisory-lock → head SELECT → INSERT → COMMIT in order (SQL shape)", async () => {
    const clientLog: string[] = [];
    const pool = createTxnPool({ clientLog });
    const storage = await createPostgresStorage({ pool, autoMigrate: true });

    await storage.appendToAuditChain!(
      { id: "e1", agentId: "a", eventType: "t", outcome: "allow", severity: "info", organizationId: "org1", createdAt: new Date().toISOString() },
      async (head) => ({ hash: "h1", previousHash: head?.hash ?? "0".repeat(64), sequence: (head?.sequence ?? 0) + 1, signedAt: new Date().toISOString() }),
    );

    assert.deepEqual(clientLog, ["BEGIN ISOLATION", "SELECT pg_advisory_xact_lock", "SELECT integrity_sequence,", "INSERT INTO", "COMMIT"]);
  });

  it("derives sequence + previousHash from the DB head across sequential appends", async () => {
    const pool = createTxnPool();
    const storage = await createPostgresStorage({ pool, autoMigrate: true });
    const seen: Array<{ prev: string; seq: number }> = [];

    for (let i = 0; i < 3; i++) {
      await storage.appendToAuditChain!(
        { id: `e${i}`, agentId: "a", eventType: "t", outcome: "allow", severity: "info", organizationId: "org1", createdAt: new Date().toISOString() },
        async (head) => {
          const meta = { hash: `hash${i}`, previousHash: head?.hash ?? "GENESIS", sequence: (head?.sequence ?? 0) + 1, signedAt: new Date().toISOString() };
          seen.push({ prev: meta.previousHash, seq: meta.sequence });
          return meta;
        },
      );
    }

    // Each write saw the prior write's committed head — sequences 1,2,3 and
    // previousHash links to the last row's hash (not a process-local guess).
    assert.deepEqual(seen.map((s) => s.seq), [1, 2, 3]);
    assert.deepEqual(seen.map((s) => s.prev), ["GENESIS", "hash0", "hash1"]);
  });

  it("interleaves two governance instances over one pool into a contiguous chain (orchestration)", async () => {
    const pool = createTxnPool();
    const storage = await createPostgresStorage({ pool, autoMigrate: true });
    const podA = createGovernance({ storage, integrityAudit: { signingKey: KEY } });
    const podB = createGovernance({ storage, integrityAudit: { signingKey: KEY } });

    const N = 30;
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      writes.push((i % 2 ? podB : podA).enforce({ agentId: `a${i}`, organizationId: "orgP", action: "tool_call", tool: "t" }));
    }
    await Promise.all(writes);

    const chain = await podA.integrityChain!.export({ organizationId: "orgP" });
    assert.equal(chain.length, N);
    const sequences = chain.map((e) => e.integrity.sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, Array.from({ length: N }, (_, i) => i + 1));
    const result = await verifyAuditIntegrity(chain, KEY);
    assert.equal(result.valid, true, result.breakDetail ?? "invalid");
  });
});

describe("postgres appendToAuditChain — retry fallback (no connect())", () => {
  it("recovers from a unique-violation by re-reading the head and retrying", async () => {
    // A query-only pool (no connect) exercises the retry path. Simulate a
    // stale first attempt: a competing row lands at sequence 1 before our
    // INSERT, so the first insert 23505s and the retry re-reads head → seq 2.
    const rows: AuditRowShape[] = [];
    let firstInsert = true;
    const pool: PgPoolLike = {
      async query(text: string, values?: unknown[]) {
        const t = text.trim();
        if (t.includes("CREATE") || t.includes("ALTER") || t.includes("DROP INDEX")) return { rows: [], rowCount: 0 } as never;
        if (t.startsWith("SELECT") && t.includes("integrity_sequence IS NOT NULL")) {
          if (rows.length === 0) return { rows: [], rowCount: 0 } as never;
          const top = rows.reduce((a, b) => (b.integrity_sequence > a.integrity_sequence ? b : a));
          return { rows: [{ integrity_sequence: top.integrity_sequence, integrity_hash: top.integrity_hash }], rowCount: 1 } as never;
        }
        if (t.startsWith("INSERT")) {
          const seq = values![11] as number;
          if (firstInsert) {
            firstInsert = false;
            // A competitor grabbed sequence 1 first.
            rows.push({ organization_id: null, integrity_sequence: 1, integrity_hash: "competitor" });
          }
          if (rows.some((r) => r.integrity_sequence === seq)) {
            throw Object.assign(new Error("duplicate"), { code: "23505" });
          }
          rows.push({ organization_id: values![7] as string | null, integrity_sequence: seq, integrity_hash: values![9] as string });
          return { rows: [], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };

    const storage = await createPostgresStorage({ pool, autoMigrate: true });
    const attempts: number[] = [];
    const { integrity } = await storage.appendToAuditChain!(
      { id: "e1", agentId: "a", eventType: "t", outcome: "allow", severity: "info", createdAt: new Date().toISOString() },
      async (head) => {
        const seq = (head?.sequence ?? 0) + 1;
        attempts.push(seq);
        return { hash: "mine", previousHash: head?.hash ?? "GEN", sequence: seq, signedAt: new Date().toISOString() };
      },
    );

    // First attempt derived seq 1 (empty head) → 23505; retry saw the
    // competitor's row and derived seq 2 with prevHash = competitor's hash.
    assert.deepEqual(attempts, [1, 2]);
    assert.equal(integrity.sequence, 2);
    assert.equal(integrity.previousHash, "competitor");
  });

  it("absorbs N-way same-org contention without dropping a write", async () => {
    // Every 23505 means a competitor committed the derived sequence, so a
    // writer loses at most once per concurrent contender: with 10 writers and
    // MAX_ATTEMPTS=12 completion is guaranteed, not probabilistic.
    const rows: AuditRowShape[] = [];
    const pool: PgPoolLike = {
      async query(text: string, values?: unknown[]) {
        const t = text.trim();
        if (t.includes("CREATE") || t.includes("ALTER") || t.includes("DROP INDEX")) return { rows: [], rowCount: 0 } as never;
        if (t.startsWith("SELECT") && t.includes("integrity_sequence IS NOT NULL")) {
          if (rows.length === 0) return { rows: [], rowCount: 0 } as never;
          const top = rows.reduce((a, b) => (b.integrity_sequence > a.integrity_sequence ? b : a));
          return { rows: [{ integrity_sequence: top.integrity_sequence, integrity_hash: top.integrity_hash }], rowCount: 1 } as never;
        }
        if (t.startsWith("INSERT")) {
          const seq = values![11] as number;
          if (rows.some((r) => r.integrity_sequence === seq)) {
            throw Object.assign(new Error("duplicate"), { code: "23505" });
          }
          rows.push({ organization_id: values![7] as string | null, integrity_sequence: seq, integrity_hash: values![9] as string });
          return { rows: [], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };

    const storage = await createPostgresStorage({ pool, autoMigrate: true });
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        storage.appendToAuditChain!(
          { id: `e${i}`, agentId: `a${i}`, eventType: "t", outcome: "allow", severity: "info", organizationId: "orgC", createdAt: new Date().toISOString() },
          async (head) => ({ hash: `h${i}`, previousHash: head?.hash ?? "GEN", sequence: (head?.sequence ?? 0) + 1, signedAt: new Date().toISOString() }),
        ),
      ),
    );

    assert.equal(rows.length, N);
    const sequences = rows.map((r) => r.integrity_sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, Array.from({ length: N }, (_, i) => i + 1));
  });
});

describe("postgres appendToAuditChain — connection hygiene on failure", () => {
  function failingPool(opts: { rollbackFails: boolean; releaseArgs: unknown[][]; insertErr: Error; rollbackErr: Error }): PgPoolLike {
    return {
      async query() {
        return { rows: [], rowCount: 0 } as never; // migrations
      },
      async connect(): Promise<PgClientLike> {
        return {
          async query(text: string) {
            const t = text.trim();
            if (t.startsWith("INSERT")) throw opts.insertErr;
            if (t.startsWith("ROLLBACK") && opts.rollbackFails) throw opts.rollbackErr;
            return { rows: [], rowCount: 0 } as never;
          },
          release(...args: unknown[]) {
            opts.releaseArgs.push(args);
          },
        };
      },
      async end() {},
    };
  }

  const auditEvent = { id: "e1", agentId: "a", eventType: "t", outcome: "allow" as const, severity: "info", createdAt: new Date().toISOString() };
  const compute = async () => ({ hash: "h", previousHash: "0".repeat(64), sequence: 1, signedAt: new Date().toISOString() });

  it("destroys the client — release(err) — when ROLLBACK fails after a failed write", async () => {
    const releaseArgs: unknown[][] = [];
    const insertErr = Object.assign(new Error("insert exploded"), { code: "XX000" });
    const rollbackErr = new Error("connection terminated");
    const pool = failingPool({ rollbackFails: true, releaseArgs, insertErr, rollbackErr });

    const storage = await createPostgresStorage({ pool, autoMigrate: true });
    await assert.rejects(storage.appendToAuditChain!(auditEvent, compute), insertErr);

    // Released exactly once, WITH the rollback error → pool destroys the
    // connection instead of handing an aborted/dead one to the next caller.
    assert.equal(releaseArgs.length, 1);
    assert.equal(releaseArgs[0][0], rollbackErr);
  });

  it("releases the client cleanly when ROLLBACK succeeds", async () => {
    const releaseArgs: unknown[][] = [];
    const insertErr = Object.assign(new Error("insert exploded"), { code: "XX000" });
    const pool = failingPool({ rollbackFails: false, releaseArgs, insertErr, rollbackErr: new Error("unused") });

    const storage = await createPostgresStorage({ pool, autoMigrate: true });
    await assert.rejects(storage.appendToAuditChain!(auditEvent, compute), insertErr);

    assert.equal(releaseArgs.length, 1);
    assert.equal(releaseArgs[0][0], undefined);
  });
});
