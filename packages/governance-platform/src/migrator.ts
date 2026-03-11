/**
 * Auto-migrating schema manager.
 * Tracks applied migrations in _platform_migrations table.
 * Idempotent — safe to call on every startup.
 */

import type { PgPoolLike } from "./types.js";
import { MIGRATIONS } from "./migrations.js";

const MIGRATION_TABLE = "_platform_migrations";

/**
 * Ensure the migration tracking table exists, then apply any pending migrations.
 * Returns the number of migrations applied (0 if already up to date).
 */
export async function runMigrations(pool: PgPoolLike): Promise<number> {
  // Create tracking table if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Find which migrations have been applied
  const applied = await pool.query<{ id: number }>(
    `SELECT id FROM ${MIGRATION_TABLE} ORDER BY id`,
  );
  const appliedIds = new Set(applied.rows.map((r) => r.id));

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;

    await pool.query(migration.sql);
    await pool.query(
      `INSERT INTO ${MIGRATION_TABLE} (id, name) VALUES ($1, $2)`,
      [migration.id, migration.name],
    );
    count++;
  }

  return count;
}
