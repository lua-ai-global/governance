/**
 * Shared types for platform storage.
 * These are the DB-level shapes — apps map them to their own UI types.
 */

/** Minimal pg.Pool-compatible interface (works with pg, @neondatabase/serverless, etc.) */
export interface PgPoolLike {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** A policy rule as stored in JSONB — aligned with SDK PolicyRule */
export interface StoredPolicyRule {
  id: string;
  name: string;
  condition: { type: string; params: Record<string, unknown> };
  outcome: string;
  reason: string;
  priority: number;
  enabled: boolean;
  stage?: string;
}

/** A saved policy record from the saved_policies table */
export interface StoredSavedPolicy {
  id: string;
  clerkOrgId: string;
  name: string;
  description: string;
  rules: StoredPolicyRule[];
  version: number;
  isOrgDefault: boolean;
  assignedLevels: number[];
  assignedAgents: string[];
  createdAt: string;
  updatedAt: string;
}

/** Org settings as stored in the DB */
export interface StoredOrgSettings {
  clerkOrgId: string;
  plan: string;
  settings: OrgPreferences;
  createdAt: string;
  updatedAt: string;
}

/** Kill switch state persisted in org settings */
export interface KillSwitchState {
  reason: string;
  killedAt: string;
  killedBy?: string;
  scope: "fleet" | "agent";
  agentId?: string;
}

/** Org-level preferences stored in settings JSONB */
export interface OrgPreferences {
  autoRegisterAgents: boolean;
  killSwitch?: KillSwitchState | null;
}

/** Partial update payload — each field is optional */
export interface OrgSettingsUpdate {
  settings?: Partial<OrgPreferences>;
}

export interface PlatformStorageConfig {
  pool: PgPoolLike;
  autoMigrate?: boolean;
}
