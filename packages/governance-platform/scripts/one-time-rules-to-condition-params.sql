-- One-time data fix: convert policy rules from old shape to new shape.
-- Run this once in Neon SQL editor. No migration framework.
--
-- Old: condition (string), config (object)
-- New: condition: { type, params }, reason (string)
--
-- Also maps: require_sequence → tool_sequence, token_budget → token_limit,
-- and renames param keys (injectionThreshold→threshold, etc.) for SDK compatibility.

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
  -- Already new shape?
  IF r ? 'condition' AND jsonb_typeof(r->'condition') = 'object'
     AND (r->'condition') ? 'type' THEN
    RETURN r;
  END IF;

  -- Need config and condition string
  IF NOT (r ? 'condition' AND r ? 'config') THEN
    RETURN r;
  END IF;

  c_type := r->>'condition';
  IF c_type = 'require_sequence' THEN c_type := 'tool_sequence';
  ELSIF c_type = 'token_budget' THEN c_type := 'token_limit';
  END IF;

  c_old := r->'config';

  -- Copy params with key renames
  FOR k, v IN SELECT * FROM jsonb_each(c_old)
  LOOP
    IF k = 'injectionThreshold' THEN
      p := p || jsonb_build_object('threshold', v);
    ELSIF k = 'injectionSkipCategories' THEN
      p := p || jsonb_build_object('skipCategories', v);
    ELSIF k = 'patternFlags' THEN
      p := p || jsonb_build_object('flags', v);
    ELSIF k = 'sensitivePatterns' THEN
      p := p || jsonb_build_object('patterns', v);
    ELSIF k IN ('startHour', 'endHour') THEN
      NULL;  -- handle below
    ELSE
      p := p || jsonb_build_object(k, v);
    END IF;
  END LOOP;

  -- time_window: allowedHours from startHour/endHour
  IF c_old ? 'startHour' OR c_old ? 'endHour' THEN
    sh := COALESCE((c_old->>'startHour')::int, 9);
    eh := COALESCE((c_old->>'endHour')::int, 17);
    p := p || jsonb_build_object('allowedHours', jsonb_build_object('start', sh, 'end', eh));
  END IF;

  RETURN jsonb_build_object(
    'id', r->'id',
    'name', r->'name',
    'condition', jsonb_build_object('type', c_type, 'params', p),
    'outcome', r->'outcome',
    'reason', COALESCE(r->>'reason', 'Policy: ' || COALESCE(r->>'name', 'Rule')),
    'priority', COALESCE((r->'priority')::int, 50),
    'enabled', COALESCE((r->'enabled')::bool, true),
    'stage', r->'stage'
  );
END;
$$;

-- Convert a JSONB array of rules
CREATE OR REPLACE FUNCTION _convert_rules_array(arr jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT jsonb_agg(_convert_one_rule(elem)) FROM jsonb_array_elements(arr) AS elem),
    '[]'::jsonb
  );
$$;

-- Convert a JSONB object of level/agent -> rules[]
CREATE OR REPLACE FUNCTION _convert_rules_object(obj jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT jsonb_object_agg(key, _convert_rules_array(value))
     FROM jsonb_each(obj)),
    '{}'::jsonb
  );
$$;

-- Apply to org_settings
UPDATE org_settings
SET
  policy_rules  = _convert_rules_array(policy_rules),
  level_policies = _convert_rules_object(level_policies),
  agent_overrides = _convert_rules_object(agent_overrides),
  updated_at = now()
WHERE policy_rules != _convert_rules_array(policy_rules)
   OR level_policies != _convert_rules_object(level_policies)
   OR agent_overrides != _convert_rules_object(agent_overrides);

-- Apply to saved_policies
UPDATE saved_policies
SET rules = _convert_rules_array(rules), updated_at = now()
WHERE rules != _convert_rules_array(rules);

-- Optional: drop the helpers so they don't clutter the DB
DROP FUNCTION IF EXISTS _convert_one_rule(jsonb);
DROP FUNCTION IF EXISTS _convert_rules_array(jsonb);
DROP FUNCTION IF EXISTS _convert_rules_object(jsonb);
