-- 0014 · Workflow schedules fire
--
-- The `schedules` table has existed since 0007; nothing wrote to it, because a workflow
-- only ran when somebody ran it. Now the worker sweeps it, which needs two things the
-- original table did not have:
--
--   1. one schedule per target, enforced rather than assumed — two rows for the same
--      workflow means two firings for every one the owner asked for;
--   2. a catch-up policy that cannot hold a value the scheduler does not implement.

CREATE UNIQUE INDEX schedules_target_key
  ON schedules (organization_id, kind, target_id)
  WHERE deleted_at IS NULL AND target_id IS NOT NULL;

-- Existing rows are all defaults, so this validates immediately.
ALTER TABLE schedules
  ADD CONSTRAINT schedules_catch_up_known
  CHECK (catch_up_policy IN ('skip_missed', 'run_once', 'run_all'));

-- A firing that was skipped is a fact about the automation, so it is recorded on the
-- schedule and readable beside the runs rather than living only in a worker log.
ALTER TABLE schedules
  ADD COLUMN last_skipped_at timestamptz,
  ADD COLUMN last_skipped_reason text,
  ADD COLUMN skipped_total integer NOT NULL DEFAULT 0;
