/**
 * Typed query helpers for org_settings and saved_policies.
 * Thin wrappers around SQL — no ORM, no abstraction layers.
 *
 * Policy rules live in saved_policies (single source of truth).
 * org_settings stores plan + preferences only.
 */

import type {
  PgPoolLike,
  StoredOrgSettings,
  StoredPolicyRule,
  StoredSavedPolicy,
  OrgPreferences,
  OrgSettingsUpdate,
} from "./types.js";

/* ------------------------------------------------------------------ */
/*  org_settings — plan + preferences                                 */
/* ------------------------------------------------------------------ */

interface OrgSettingsRow {
  clerk_org_id: string;
  plan: string;
  settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function rowToOrgSettings(row: OrgSettingsRow): StoredOrgSettings {
  return {
    clerkOrgId: row.clerk_org_id,
    plan: row.plan,
    settings: {
      autoRegisterAgents: row.settings?.autoRegisterAgents !== false,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_SETTINGS: StoredOrgSettings = {
  clerkOrgId: "",
  plan: "free",
  settings: { autoRegisterAgents: true },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * Load org settings. Returns defaults if org has no row yet.
 */
export async function loadOrgSettings(
  pool: PgPoolLike,
  orgId: string,
): Promise<StoredOrgSettings> {
  const result = await pool.query<OrgSettingsRow>(
    `SELECT clerk_org_id, plan, settings, created_at, updated_at
     FROM org_settings WHERE clerk_org_id = $1`,
    [orgId],
  );

  if (!result.rows[0]) {
    return { ...DEFAULT_SETTINGS, clerkOrgId: orgId };
  }

  return rowToOrgSettings(result.rows[0]);
}

/**
 * Save org settings (plan + preferences only).
 */
export async function saveOrgSettings(
  pool: PgPoolLike,
  orgId: string,
  update: OrgSettingsUpdate,
): Promise<void> {
  await pool.query(
    `INSERT INTO org_settings
       (clerk_org_id, settings, updated_at)
     VALUES ($1, COALESCE($2::jsonb, '{"autoRegisterAgents":true}'::jsonb), NOW())
     ON CONFLICT (clerk_org_id) DO UPDATE SET
       settings = org_settings.settings || COALESCE($2::jsonb, '{}'::jsonb),
       updated_at = NOW()`,
    [
      orgId,
      update.settings ? JSON.stringify(update.settings) : null,
    ],
  );
}

/* ------------------------------------------------------------------ */
/*  saved_policies — single source of truth for policy rules          */
/* ------------------------------------------------------------------ */

interface SavedPolicyRow {
  id: string;
  clerk_org_id: string;
  name: string;
  description: string;
  rules: StoredPolicyRule[];
  version: number;
  is_org_default: boolean;
  assigned_levels: number[];
  assigned_agents: string[];
  created_at: string;
  updated_at: string;
}

function rowToSavedPolicy(row: SavedPolicyRow): StoredSavedPolicy {
  return {
    id: row.id,
    clerkOrgId: row.clerk_org_id,
    name: row.name,
    description: row.description,
    rules: row.rules ?? [],
    version: row.version,
    isOrgDefault: row.is_org_default,
    assignedLevels: row.assigned_levels ?? [],
    assignedAgents: row.assigned_agents ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Load policy tiers for enforcement — reads directly from saved_policies.
 * Resolves is_org_default → base rules, assigned_levels → level rules,
 * assigned_agents → agent overrides.
 */
export async function loadPolicyTiers(
  pool: PgPoolLike,
  orgId: string,
): Promise<{
  plan: string;
  policyRules: StoredPolicyRule[];
  levelPolicies: Record<string, StoredPolicyRule[]>;
  agentOverrides: Record<string, StoredPolicyRule[]>;
  settings: OrgPreferences;
}> {
  // Plan + preferences from org_settings
  const orgResult = await pool.query<OrgSettingsRow>(
    `SELECT plan, settings FROM org_settings WHERE clerk_org_id = $1`,
    [orgId],
  );

  // All saved policies for this org
  const policiesResult = await pool.query<SavedPolicyRow>(
    `SELECT * FROM saved_policies WHERE clerk_org_id = $1`,
    [orgId],
  );

  const policyRules: StoredPolicyRule[] = [];
  const levelPolicies: Record<string, StoredPolicyRule[]> = {};
  const agentOverrides: Record<string, StoredPolicyRule[]> = {};

  for (const row of policiesResult.rows) {
    const rules = (row.rules ?? []).filter((r) => r.enabled !== false);
    if (rules.length === 0) continue;

    // Org-default policies apply to all agents
    if (row.is_org_default) {
      policyRules.push(...rules);
    }

    // Level-specific assignments
    for (const lvl of row.assigned_levels ?? []) {
      const key = String(lvl);
      levelPolicies[key] = [...(levelPolicies[key] ?? []), ...rules];
    }

    // Agent-specific overrides
    for (const agentId of row.assigned_agents ?? []) {
      agentOverrides[agentId] = [
        ...(agentOverrides[agentId] ?? []),
        ...rules,
      ];
    }
  }

  const orgRow = orgResult.rows[0];
  return {
    plan: orgRow?.plan ?? "free",
    policyRules,
    levelPolicies,
    agentOverrides,
    settings: {
      autoRegisterAgents: orgRow?.settings?.autoRegisterAgents !== false,
    },
  };
}

/**
 * List all saved policies for an org.
 */
export async function listSavedPolicies(
  pool: PgPoolLike,
  orgId: string,
): Promise<StoredSavedPolicy[]> {
  const result = await pool.query<SavedPolicyRow>(
    `SELECT * FROM saved_policies WHERE clerk_org_id = $1 ORDER BY updated_at DESC`,
    [orgId],
  );
  return result.rows.map(rowToSavedPolicy);
}
