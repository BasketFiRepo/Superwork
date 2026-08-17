DROP INDEX IF EXISTS workflows_limits_set_idx;

ALTER TABLE workflows
  DROP CONSTRAINT IF EXISTS workflows_limits_are_attributed,
  DROP CONSTRAINT IF EXISTS workflows_limits_are_sane;

ALTER TABLE workflows
  DROP COLUMN IF EXISTS limits_reason,
  DROP COLUMN IF EXISTS limits_set_at,
  DROP COLUMN IF EXISTS limits_set_by;
