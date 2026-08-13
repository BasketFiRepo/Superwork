-- 0011 · rollback

DROP POLICY IF EXISTS api_key_lookup ON public.api_keys;

DROP TABLE IF EXISTS api_requests CASCADE;
DROP TABLE IF EXISTS api_keys CASCADE;
DROP TABLE IF EXISTS identity_settings CASCADE;
DROP TABLE IF EXISTS integration_connections CASCADE;
DROP TABLE IF EXISTS disclosures CASCADE;
DROP TABLE IF EXISTS agent_digests CASCADE;
DROP TABLE IF EXISTS agent_change_requests CASCADE;
DROP TABLE IF EXISTS agent_simulations CASCADE;

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS data_region_allowed,
  DROP COLUMN IF EXISTS allowed_regions,
  DROP COLUMN IF EXISTS data_region;

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS digest_day_valid,
  DROP CONSTRAINT IF EXISTS autopilot_caps_positive,
  DROP COLUMN IF EXISTS digest_day,
  DROP COLUMN IF EXISTS autopilot_paused_until,
  DROP COLUMN IF EXISTS autopilot_weekly_cost_cap_cents,
  DROP COLUMN IF EXISTS autopilot_daily_action_cap;

DROP TYPE IF EXISTS sw_change_status;
