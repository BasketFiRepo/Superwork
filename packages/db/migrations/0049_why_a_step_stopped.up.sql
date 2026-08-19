-- 0049 — Why a step stopped.
--
-- `workflow_step_runs.error` is selected by `listWorkflowRuns` straight into the run detail
-- screen, and **no code path has ever written it**. That was the smaller half of the problem.
--
-- The larger half: the executor's `try` sits outside the node loop, so when a node throws, the
-- run is marked failed with the message and *no step row is written for the node that threw*.
-- The step list on the screen simply ends at the last thing that worked. A person reading it
-- sees four steps that succeeded, a run marked failed, and no indication of which step was the
-- one — they have to guess from the run's own sentence, which names the error and not the node.
--
-- Two constraints, because the guarantee is worth more than the column:
--
--   A failed step says why. If `status = 'failed'` there is a reason of at least a few
--   characters, and if it did not fail there is no reason — so "it failed and we do not know
--   what happened" cannot be stored, by anybody, whatever the executor does next.
--
--   A step's status is one of the words the executor actually uses. The column was free text
--   with a default of 'queued', which is a status no step is ever written in: rows are inserted
--   once, after the work, in their final state.
--
-- `duration_ms` gets a writer here too. It is the same failure one column along — declared,
-- never written — and it is what turns "the run took a while" into "this step took the while".

ALTER TABLE workflow_step_runs
  ADD CONSTRAINT workflow_step_runs_status_known
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'awaiting_approval')),
  -- Both directions. The second half is what stops a reason drifting onto a step that is fine,
  -- which would read as a failure on a screen that shows one.
  ADD CONSTRAINT workflow_step_runs_failed_says_why
    CHECK ((status = 'failed') = (error IS NOT NULL AND length(btrim(error)) >= 3)),
  ADD CONSTRAINT workflow_step_runs_duration_sane
    CHECK (duration_ms IS NULL OR duration_ms >= 0);
