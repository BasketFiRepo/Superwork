ALTER TABLE workflow_step_runs
  DROP CONSTRAINT IF EXISTS workflow_step_runs_status_known,
  DROP CONSTRAINT IF EXISTS workflow_step_runs_failed_says_why,
  DROP CONSTRAINT IF EXISTS workflow_step_runs_duration_sane;
