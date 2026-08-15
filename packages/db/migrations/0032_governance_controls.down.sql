DROP INDEX IF EXISTS agent_permissions_org_department_idx;
DROP TRIGGER IF EXISTS agent_permissions_same_org ON agent_permissions;
DROP FUNCTION IF EXISTS sw_agent_permission_same_org();
DROP INDEX IF EXISTS agent_permissions_one_per_scope;
ALTER TABLE agent_permissions
  DROP COLUMN IF EXISTS reason,
  DROP CONSTRAINT IF EXISTS agent_permissions_effect_known;

ALTER TABLE monitoring_policies
  DROP COLUMN IF EXISTS set_at,
  DROP COLUMN IF EXISTS set_by,
  DROP COLUMN IF EXISTS reason,
  DROP CONSTRAINT IF EXISTS monitoring_window_sane,
  DROP CONSTRAINT IF EXISTS monitoring_budget_sane,
  DROP CONSTRAINT IF EXISTS monitoring_profile_known;
