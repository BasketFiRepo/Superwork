-- 0064 — What a workflow run costs.
--
-- `workflow_runs.cost_cents` and `workflow_step_runs.cost_cents` have existed since 0007 and
-- nothing has ever written either. `listWorkflowRuns` selects the run's into every
-- `WorkflowRunView`, and the workflow page — the only thing that renders a run — never shows it.
-- The step's is read by nothing at all.
--
-- Reading the engine for *why* turned up something better than a bug. A workflow run does not
-- call the model. `query` nodes run SQL, `for_each` fans out over rows, `action` nodes compile
-- planned tool calls from the graph and preview them, `approval` raises an approval and
-- `notify` writes notifications. Not one of them asks a model anything, on purpose: §11 is a
-- graph a person read back and activated, and the anti-pattern list says numbers come from SQL
-- rather than from the model. So zero is not a stale number here. It is the right one, and it is
-- the reason a workflow is cheap and predictable.
--
-- That is worth *saying* rather than leaving as an unwritten column somebody eventually fills in
-- with a guess. Two changes, in opposite directions.

/**
 * The run's cost is the sum of the agent runs it hangs off, kept by the database.
 *
 * A real (non-simulated) run opens an `agent_runs` row with a `maxCostCents` budget and appends
 * it to `agent_run_ids`. Today nothing on that path spends anything, so the sum is zero — but it
 * is zero *because the agent runs say so*, which is a different fact from zero because nobody
 * ever wrote the column. The day a step does call a model, the number is already right.
 *
 * This is 0037's pattern, and 0037's reason: when two places must agree, the agreement is not
 * something application code should be trusted to remember. `agent_runs.cost_cents` is itself
 * recomputed from `agent_messages` by `sw_agent_run_usage`, so this rolls up behind that one.
 * Recomputed rather than incremented, so a corrected message leaves the total right rather than
 * drifted by the size of the correction.
 */
CREATE OR REPLACE FUNCTION sw_workflow_run_cost() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.cost_cents := (
    SELECT coalesce(sum(a.cost_cents), 0)::numeric(12,4)
    FROM agent_runs a
    WHERE a.id = ANY(NEW.agent_run_ids) AND a.deleted_at IS NULL
  );
  RETURN NEW;
END
$$;

-- Every insert and *every* update, with no WHEN clause — which is the opposite of the two-trigger
-- split 0057 introduced, on purpose.
--
-- That split exists for rules that *refuse*: a guard narrowed to the arriving value, so a later
-- edit over some other column is not turned down for a fact it never touched. This trigger
-- refuses nothing, it computes — and the first draft of it did carry a WHEN guard, on
-- `agent_run_ids` changing. A test written to prove the number was the database's found the hole
-- in a line: `SET agent_run_ids = agent_run_ids, cost_cents = 4000` is not a distinct array, so
-- the guard declined to fire and the wrong number stuck. The gap in a derived column is exactly
-- where somebody writes the column without touching its inputs.
--
-- Recomputing unconditionally also makes the rollup below safe: its UPDATE re-enters here and
-- arrives at the same sum, because both read the same array.
CREATE TRIGGER workflow_runs_cost_insert
  BEFORE INSERT ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION sw_workflow_run_cost();

CREATE TRIGGER workflow_runs_cost_update
  BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION sw_workflow_run_cost();

/**
 * And the other direction: the cost arrives after the link does.
 *
 * The engine appends the agent run id before the run has spent anything, so the insert-side
 * trigger can only ever see zero. What makes the number true later is this: when an agent run's
 * cost changes, every workflow run holding it recomputes.
 *
 * Guarded on the value actually changing, so the touch trigger's own writes do not walk the
 * array for nothing on every unrelated edit to an agent run.
 */
CREATE OR REPLACE FUNCTION sw_workflow_run_cost_rollup() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE workflow_runs r
  SET cost_cents = (
    SELECT coalesce(sum(a.cost_cents), 0)::numeric(12,4)
    FROM agent_runs a
    WHERE a.id = ANY(r.agent_run_ids) AND a.deleted_at IS NULL
  )
  WHERE r.organization_id = NEW.organization_id
    AND NEW.id = ANY(r.agent_run_ids);
  RETURN NULL;
END
$$;

CREATE TRIGGER agent_runs_workflow_cost
  AFTER UPDATE ON agent_runs
  FOR EACH ROW WHEN (NEW.cost_cents IS DISTINCT FROM OLD.cost_cents)
  EXECUTE FUNCTION sw_workflow_run_cost_rollup();

-- "Which workflow runs hold this agent run", which is the read the rollup makes per changed
-- agent run. Without it that is a sequential scan of every workflow run in the database.
CREATE INDEX workflow_runs_agent_runs_idx ON workflow_runs USING gin (agent_run_ids);

/**
 * The step's cost goes, because there is no honest way to fill it.
 *
 * Model spend is recorded per call on `agent_messages`, which carries a `task_class` and no node
 * id — the run is the unit, not the step. Splitting one run's cost across its steps would mean
 * inventing a rule (evenly? by duration? by tool?) and printing the result as a measurement.
 *
 * Nothing reads it, nothing can write it, and a column that would have to be guessed is worse
 * than no column: the reader cannot tell a measured zero from an invented one. The down script
 * puts it back exactly as it was — present, and holding nothing.
 */
ALTER TABLE workflow_step_runs DROP COLUMN cost_cents;
