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

/** A policy rule as stored in JSONB */
export interface StoredPolicyRule {
  id: string;
  name: string;
  condition: string;
  action: string;
  priority?: number;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Org settings as stored in the DB */
export interface StoredOrgSettings {
  clerkOrgId: string;
  plan: string;
  policyRules: StoredPolicyRule[];
  levelPolicies: Record<string, StoredPolicyRule[]>;
  agentOverrides: Record<string, StoredPolicyRule[]>;
  settings: OrgPreferences;
  createdAt: string;
  updatedAt: string;
}

/** Org-level preferences stored in settings JSONB */
export interface OrgPreferences {
  autoRegisterAgents: boolean;
}

/** Partial update payload — each field is optional */
export interface OrgSettingsUpdate {
  policyRules?: StoredPolicyRule[];
  levelPolicies?: Record<string, StoredPolicyRule[]>;
  agentOverrides?: Record<string, StoredPolicyRule[]>;
  settings?: Partial<OrgPreferences>;
}

export interface PlatformStorageConfig {
  pool: PgPoolLike;
  autoMigrate?: boolean;
}
