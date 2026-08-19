-- 0046 — A budget that stops something.
--
-- Every tool in the registry declares a rate limit — `{ perRun, perOrgPerHour }` — and **nothing
-- has ever read it**. Twenty-odd built-in tools carry hand-picked numbers, `custom_tools` has
-- two columns for them, and no code path consults either: `Tool.rateLimit` is a field the type
-- system enforces the *shape* of and the product enforces nothing about.
--
-- For a custom tool it is worse in the way this work keeps finding. `per_run_limit` and
-- `per_hour_limit` are read out of the row and handed to the registry — so they look enforced
-- from the repository, and they look settable from the type — but `saveCustomTool` never wrote
-- either, so every admin-authored tool that reaches a system outside this company has run on a
-- migration default of 5 and 200 chosen for nobody in particular.
--
-- The budget is what stands between a looping agent and a supplier's API at three in the
-- morning. This migration makes the numbers a person can set, and the code beside it makes
-- them stop something.

ALTER TABLE custom_tools
  ADD COLUMN limits_set_by uuid REFERENCES users(id),
  ADD COLUMN limits_set_at timestamptz,
  ADD COLUMN limits_reason text;

ALTER TABLE custom_tools
  -- Positive, bounded above, and coherent: an hourly budget below the per-run budget would
  -- mean a single run could not finish without exhausting the hour, which is not a limit
  -- anybody meant to set.
  ADD CONSTRAINT custom_tool_limits_sane
    CHECK (
      per_run_limit BETWEEN 1 AND 100
      AND per_hour_limit BETWEEN 1 AND 5000
      AND per_hour_limit >= per_run_limit
    ),
  -- A number somebody chose names them and says why; a default names nobody, which is what
  -- lets the screen tell the two apart (ADR 0044, ADR 0046).
  ADD CONSTRAINT custom_tool_limits_attributed
    CHECK (
      limits_set_by IS NULL
      OR (limits_set_at IS NOT NULL AND length(btrim(coalesce(limits_reason, ''))) >= 4)
    );

-- "How many times has this tool been called in the last hour" — the count the budget is
-- measured against, and the one the screen shows beside the number somebody set. Counted from
-- the calls that really happened rather than from a counter that resets when a process
-- restarts (§27.6).
CREATE INDEX tool_calls_tool_hour_idx
  ON tool_calls (organization_id, tool_name, created_at DESC);
