DROP INDEX IF EXISTS tool_calls_tool_hour_idx;

ALTER TABLE custom_tools
  DROP CONSTRAINT IF EXISTS custom_tool_limits_attributed,
  DROP CONSTRAINT IF EXISTS custom_tool_limits_sane;

ALTER TABLE custom_tools
  DROP COLUMN IF EXISTS limits_reason,
  DROP COLUMN IF EXISTS limits_set_at,
  DROP COLUMN IF EXISTS limits_set_by;
