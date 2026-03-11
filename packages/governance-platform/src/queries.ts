/**
 * Typed query helpers for org_settings.
 * Thin wrappers around SQL — no ORM, no abstraction layers.
 */

import type {
  PgPoolLike,
  StoredOrgSettings,
  StoredPolicyRule,
  OrgPreferences,
  OrgSettingsUpdate,
} from "./types.js";

/** Raw DB row shape */
interface OrgSettingsRow {
  clerk_org_id: string;
  plan: string;
  policy_rules: StoredPolicyRule[] | null;
  level_policies: Record<string, StoredPolicyRule[]> | null;
  agent_overrides: Record<string, StoredPolicyRule[]> | null;
  settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function rowToOrgSettings(row: OrgSettingsRow): StoredOrgSettings {
  return {
    clerkOrgId: row.clerk_org_id,
    plan: row.plan,
    policyRules: row.policy_rules ?? [],
    levelPolicies: row.level_policies ?? {},
    agentOverrides: row.agent_overrides ?? {},
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
  policyRules: [],
  levelPolicies: {},
  agentOverrides: {},
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
    `SELECT clerk_org_id, plan, policy_rules, level_policies,
            agent_overrides, settings, created_at, updated_at
     FROM org_settings WHERE clerk_org_id = $1`,
    [orgId],
  );

  if (!result.rows[0]) {
    return { ...DEFAULT_SETTINGS, clerkOrgId: orgId };
  }

  return rowToOrgSettings(result.rows[0]);
}

/**
 * Save org settings. Partial — only updates fields present in the payload.
 * Uses UPSERT with COALESCE so unspecified fields keep their current values.
 */
export async function saveOrgSettings(
  pool: PgPoolLike,
  orgId: string,
  update: OrgSettingsUpdate,
): Promise<void> {
  await pool.query(
    `INSERT INTO org_settings
       (clerk_org_id, policy_rules, level_policies, agent_overrides, settings, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, NOW())
     ON CONFLICT (clerk_org_id) DO UPDATE SET
       policy_rules = COALESCE($2::jsonb, org_settings.policy_rules),
       level_policies = COALESCE($3::jsonb, org_settings.level_policies),
       agent_overrides = COALESCE($4::jsonb, org_settings.agent_overrides),
       settings = org_settings.settings || COALESCE($5::jsonb, '{}'::jsonb),
       updated_at = NOW()`,
    [
      orgId,
      update.policyRules !== undefined
        ? JSON.stringify(update.policyRules)
        : null,
      update.levelPolicies !== undefined
        ? JSON.stringify(update.levelPolicies)
        : null,
      update.agentOverrides !== undefined
        ? JSON.stringify(update.agentOverrides)
        : null,
      update.settings ? JSON.stringify(update.settings) : null,
    ],
  );
}

/**
 * Load just the policy tiers for enforcement (lightweight read).
 * Returns the raw pieces needed for three-tier resolution.
 */
export async function loadPolicyTiers(
  pool: PgPoolLike,
  orgId: string,
): Promise<{
  policyRules: StoredPolicyRule[];
  levelPolicies: Record<string, StoredPolicyRule[]>;
  agentOverrides: Record<string, StoredPolicyRule[]>;
  settings: OrgPreferences;
}> {
  const result = await pool.query<OrgSettingsRow>(
    `SELECT policy_rules, level_policies, agent_overrides, settings
     FROM org_settings WHERE clerk_org_id = $1`,
    [orgId],
  );

  const row = result.rows[0];
  return {
    policyRules: row?.policy_rules ?? [],
    levelPolicies: row?.level_policies ?? {},
    agentOverrides: row?.agent_overrides ?? {},
    settings: {
      autoRegisterAgents: row?.settings?.autoRegisterAgents !== false,
    },
  };
}
