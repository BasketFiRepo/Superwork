-- 0015 · Watchers run on the cadence they declare
--
-- Every watcher has carried a `cadence` cron string since the framework was written, and
-- nothing read it: the worker ran all six every fifteen minutes. A watcher that says it
-- looks for stale threads at 08:00 on weekdays and actually looks ninety-six times a day
-- is lying in its own source, and it means an approval-aging check and a weekly
-- knowledge-gap check cost the same.
--
-- Watchers are code, not rows, so their schedules are keyed by `target_key` rather than
-- `target_id` — which the 0014 index deliberately excluded. This is its counterpart.

CREATE UNIQUE INDEX schedules_target_key_name
  ON schedules (organization_id, kind, target_key)
  WHERE deleted_at IS NULL AND target_key IS NOT NULL;

-- A schedule addresses exactly one thing: a row or a name, never both and never neither.
-- Without this a schedule could carry a target_id and a target_key that disagree, and the
-- two unique indexes above would each be satisfied while the row meant nothing.
ALTER TABLE schedules
  ADD CONSTRAINT schedules_one_target
  CHECK ((target_id IS NULL) <> (target_key IS NULL));
