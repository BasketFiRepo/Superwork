-- Undoes 0064. `workflow_step_runs.cost_cents` comes back exactly as it was — present, and
-- holding nothing, because nothing ever wrote it — and `workflow_runs.cost_cents` goes back to
-- being a stored zero nobody maintains.

ALTER TABLE workflow_step_runs
  ADD COLUMN cost_cents numeric(12,4) NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS agent_runs_workflow_cost ON agent_runs;
DROP FUNCTION IF EXISTS sw_workflow_run_cost_rollup();

DROP TRIGGER IF EXISTS workflow_runs_cost_update ON workflow_runs;
DROP TRIGGER IF EXISTS workflow_runs_cost_insert ON workflow_runs;
DROP FUNCTION IF EXISTS sw_workflow_run_cost();

DROP INDEX IF EXISTS workflow_runs_agent_runs_idx;
