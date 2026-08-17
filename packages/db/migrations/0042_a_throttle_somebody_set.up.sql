-- 0042 — A throttle somebody set.
--
-- `workflows.max_concurrent_runs` and `workflows.daily_action_cap` have existed since
-- migration 0007 and nothing has ever written either. Both are read on every firing and both
-- are enforced: a workflow with unfinished runs does not queue another, and one that has hit
-- its cap is skipped for the rest of the day. Every workflow in every organization has run on
-- the column defaults — 1 and 100 — chosen by a migration for nobody in particular.
--
-- The skip message says it out loud: *"Raise the cap if that is too low — it is a number
-- somebody set, not a failure."* Nobody set it, and nobody could raise it.
--
-- A throttle on an automation is a governance number, so it is recorded the way the other
-- ones are (ADR 0044): who chose it, when, and why. A default stays visibly unattributed —
-- "nobody has chosen this" is the honest state, and the screen can then say so.

ALTER TABLE workflows
  ADD COLUMN limits_set_by uuid REFERENCES users(id),
  ADD COLUMN limits_set_at timestamptz,
  ADD COLUMN limits_reason text;

ALTER TABLE workflows
  -- Positive, and bounded above. A cap of a million is somebody meaning "no limit", and no
  -- limit is not on offer for an automation that acts unattended: the ceiling is the point.
  ADD CONSTRAINT workflows_limits_are_sane
    CHECK (max_concurrent_runs BETWEEN 1 AND 50 AND daily_action_cap BETWEEN 1 AND 10000),
  -- A number somebody chose names them and says why. Defaults name nobody, which is exactly
  -- what the screen needs to be able to tell the reader.
  ADD CONSTRAINT workflows_limits_are_attributed
    CHECK (
      limits_set_by IS NULL
      OR (limits_set_at IS NOT NULL AND length(btrim(coalesce(limits_reason, ''))) >= 4)
    );

-- Every throttle a person has chosen, most recent first: the read a governance review wants.
CREATE INDEX workflows_limits_set_idx
  ON workflows (organization_id, limits_set_at DESC)
  WHERE limits_set_by IS NOT NULL AND deleted_at IS NULL;
