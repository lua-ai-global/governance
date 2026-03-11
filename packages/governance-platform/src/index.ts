/**
 * @lua-ai-global/governance-platform — Platform storage layer.
 *
 * Auto-migrating schema for org settings, policy tiers, and platform config.
 * Both governance-web (dashboard) and governance-api (enforce) depend on this.
 *
 * @example
 * ```ts
 * import { createPlatformStorage } from "@lua-ai-global/governance-platform";
 *
 * const platform = await createPlatformStorage({ pool });
 * const settings = await platform.loadOrgSettings(orgId);
 * ```
 */

import type { PgPoolLike, PlatformStorageConfig } from "./types.js";
import { runMigrations } from "./migrator.js";
import { loadOrgSettings, saveOrgSettings, loadPolicyTiers } from "./queries.js";
import type { StoredOrgSettings, OrgSettingsUpdate } from "./types.js";

export interface PlatformStorage {
  /** Load full org settings (returns defaults if no row exists) */
  loadOrgSettings: (orgId: string) => Promise<StoredOrgSettings>;
  /** Save org settings (partial — only updates provided fields) */
  saveOrgSettings: (orgId: string, update: OrgSettingsUpdate) => Promise<void>;
  /** Load just policy tiers for enforcement (lightweight) */
  loadPolicyTiers: (orgId: string) => ReturnType<typeof loadPolicyTiers>;
  /** Number of migrations applied on init (0 = already up to date) */
  migrationsApplied: number;
}

/**
 * Create a platform storage instance.
 * Auto-migrates the schema on first call (idempotent).
 */
export async function createPlatformStorage(
  config: PlatformStorageConfig,
): Promise<PlatformStorage> {
  const { pool } = config;
  const autoMigrate = config.autoMigrate ?? true;

  let migrationsApplied = 0;
  if (autoMigrate) {
    migrationsApplied = await runMigrations(pool);
  }

  return {
    loadOrgSettings: (orgId) => loadOrgSettings(pool, orgId),
    saveOrgSettings: (orgId, update) => saveOrgSettings(pool, orgId, update),
    loadPolicyTiers: (orgId) => loadPolicyTiers(pool, orgId),
    migrationsApplied,
  };
}

// Re-export types for consumers
export type {
  PgPoolLike,
  PlatformStorageConfig,
  StoredOrgSettings,
  StoredPolicyRule,
  OrgPreferences,
  OrgSettingsUpdate,
} from "./types.js";

export { runMigrations } from "./migrator.js";
export { MIGRATIONS } from "./migrations.js";
export { loadPolicyTiers } from "./queries.js";
