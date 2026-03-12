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
  {
    id: 3,
    name: "create-saved-policies",
    sql: `
      CREATE TABLE IF NOT EXISTS saved_policies (
        id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        clerk_org_id    TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        rules           JSONB NOT NULL DEFAULT '[]'::jsonb,
        version         INTEGER NOT NULL DEFAULT 1,
        is_org_default  BOOLEAN NOT NULL DEFAULT false,
        assigned_levels JSONB NOT NULL DEFAULT '[]'::jsonb,
        assigned_agents JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_saved_policies_org
        ON saved_policies (clerk_org_id);

      -- Backfill: if table already existed without is_org_default, add the column
      ALTER TABLE saved_policies
        ADD COLUMN IF NOT EXISTS is_org_default BOOLEAN NOT NULL DEFAULT false;

      -- Policies with no level/agent assignments become org defaults
      UPDATE saved_policies
        SET is_org_default = true
        WHERE assigned_levels = '[]'::jsonb
          AND assigned_agents = '[]'::jsonb;
    `,
  },
  {
    id: 4,
    name: "convert-rules-to-condition-params",
    sql: `
      -- Convert policy rules from old shape (condition string + config) to new (condition: { type, params } + reason).
      -- Idempotent: leaves already-converted rules unchanged.
      CREATE OR REPLACE FUNCTION _convert_one_rule(r jsonb) RETURNS jsonb
      LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE
        c_type text;
        c_old jsonb;
        p jsonb := '{}'::jsonb;
        k text;
        v jsonb;
        sh int; eh int;
      BEGIN
        IF r ? 'condition' AND jsonb_typeof(r->'condition') = 'object' AND (r->'condition') ? 'type' THEN
          RETURN r;
        END IF;
        IF NOT (r ? 'condition' AND r ? 'config') THEN
          RETURN r;
        END IF;
        c_type := r->>'condition';
        IF c_type = 'require_sequence' THEN c_type := 'tool_sequence';
        ELSIF c_type = 'token_budget' THEN c_type := 'token_limit';
        END IF;
        c_old := r->'config';
        FOR k, v IN SELECT * FROM jsonb_each(c_old)
        LOOP
          IF k = 'injectionThreshold' THEN p := p || jsonb_build_object('threshold', v);
          ELSIF k = 'injectionSkipCategories' THEN p := p || jsonb_build_object('skipCategories', v);
          ELSIF k = 'patternFlags' THEN p := p || jsonb_build_object('flags', v);
          ELSIF k = 'sensitivePatterns' THEN p := p || jsonb_build_object('patterns', v);
          ELSIF k IN ('startHour', 'endHour') THEN NULL;
          ELSE p := p || jsonb_build_object(k, v);
          END IF;
        END LOOP;
        IF c_old ? 'startHour' OR c_old ? 'endHour' THEN
          sh := COALESCE((c_old->>'startHour')::int, 9);
          eh := COALESCE((c_old->>'endHour')::int, 17);
          p := p || jsonb_build_object('allowedHours', jsonb_build_object('start', sh, 'end', eh));
        END IF;
        RETURN jsonb_build_object(
          'id', r->'id', 'name', r->'name',
          'condition', jsonb_build_object('type', c_type, 'params', p),
          'outcome', r->'outcome',
          'reason', COALESCE(r->>'reason', 'Policy: ' || COALESCE(r->>'name', 'Rule')),
          'priority', COALESCE((r->'priority')::int, 50),
          'enabled', COALESCE((r->'enabled')::bool, true),
          'stage', r->'stage'
        );
      END;
      $$;
      CREATE OR REPLACE FUNCTION _convert_rules_array(arr jsonb) RETURNS jsonb
      LANGUAGE sql IMMUTABLE AS $$
        SELECT COALESCE(
          (SELECT jsonb_agg(_convert_one_rule(elem)) FROM jsonb_array_elements(arr) AS elem),
          '[]'::jsonb
        );
      $$;
      CREATE OR REPLACE FUNCTION _convert_rules_object(obj jsonb) RETURNS jsonb
      LANGUAGE sql IMMUTABLE AS $$
        SELECT COALESCE(
          (SELECT jsonb_object_agg(key, _convert_rules_array(value)) FROM jsonb_each(obj)),
          '{}'::jsonb
        );
      $$;
      UPDATE org_settings
      SET
        policy_rules = _convert_rules_array(policy_rules),
        level_policies = _convert_rules_object(level_policies),
        agent_overrides = _convert_rules_object(agent_overrides),
        updated_at = now()
      WHERE policy_rules != _convert_rules_array(policy_rules)
         OR level_policies != _convert_rules_object(level_policies)
         OR agent_overrides != _convert_rules_object(agent_overrides);
      UPDATE saved_policies
      SET rules = _convert_rules_array(rules), updated_at = now()
      WHERE rules != _convert_rules_array(rules);
      DROP FUNCTION IF EXISTS _convert_one_rule(jsonb);
      DROP FUNCTION IF EXISTS _convert_rules_array(jsonb);
      DROP FUNCTION IF EXISTS _convert_rules_object(jsonb);
    `,
  },
];
