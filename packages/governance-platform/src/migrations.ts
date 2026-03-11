/**
 * Platform schema migrations.
 * Each migration has a unique ID, a name, and idempotent SQL.
 * Migrations are applied in order and tracked in _platform_migrations.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "create-org-settings",
    sql: `
      CREATE TABLE IF NOT EXISTS org_settings (
        id            SERIAL PRIMARY KEY,
        clerk_org_id  TEXT UNIQUE NOT NULL,
        plan          TEXT NOT NULL DEFAULT 'free',
        policy_rules  JSONB NOT NULL DEFAULT '[]'::jsonb,
        settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_org_settings_clerk_org_id
        ON org_settings(clerk_org_id);
    `,
  },
  {
    id: 2,
    name: "add-policy-tiers",
    sql: `
      ALTER TABLE org_settings
        ADD COLUMN IF NOT EXISTS level_policies JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS agent_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

      UPDATE org_settings
        SET settings = settings || '{"autoRegisterAgents": true}'::jsonb
        WHERE NOT (settings ? 'autoRegisterAgents');
    `,
  },
];
