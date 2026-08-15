DROP INDEX IF EXISTS tasks_series_idx;
DROP INDEX IF EXISTS tasks_one_open_occurrence;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_recurrence_rule_shape,
  DROP CONSTRAINT IF EXISTS tasks_recurrence_needs_series;

ALTER TABLE tasks DROP COLUMN IF EXISTS recurrence_series_id;
