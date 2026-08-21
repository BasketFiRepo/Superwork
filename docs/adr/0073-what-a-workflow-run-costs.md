# ADR 0073 — What a workflow run costs

**Status:** accepted · **Date:** 2026-08-21

## Context

`workflow_runs.cost_cents` and `workflow_step_runs.cost_cents` have existed since migration 0007
and nothing has ever written either. `listWorkflowRuns` selects the run's into every
`WorkflowRunView`; the workflow page — the only thing that renders a run — never shows it. The
step's is read by nothing at all.

I went in expecting the obvious story: a workflow spends money, the column says zero, and the
page and the analytics screen disagree about the same run. **That was wrong, and it is worth
recording that it was wrong**, because the correction is the interesting part.

A workflow run does not call the model. `query` nodes run SQL, `for_each` fans out over rows,
`action` nodes compile planned tool calls from the graph and preview them, `approval` raises an
approval, `notify` writes notifications. Not one asks a model anything, and no tool in the
catalogue does either. That is deliberate: §11 is a graph a person read back and activated, and
the anti-pattern list says numbers come from SQL rather than from the model.

So zero is not a stale number here. It is the right one, and it is the reason a workflow is cheap
and predictable rather than an unbounded bill.

## Decision

**The run's cost is the sum of the agent runs it hangs off, kept by the database.** A real run
opens an `agent_runs` row with a `maxCostCents` budget and appends it to `agent_run_ids`. Today
nothing on that path spends anything — so the sum is zero, but it is zero *because the agent runs
say so*, which is a different fact from zero because nobody ever wrote the column. The day a step
does call a model, the number is already right, and right by construction rather than because
somebody remembered to add a line beside the model call.

This is 0037's pattern and 0037's reason: when two places must agree, the agreement is not
something application code should be trusted to remember. `agent_runs.cost_cents` is itself
recomputed from `agent_messages`, so this rolls up behind that one — recomputed rather than
incremented, so a corrected message leaves the total right rather than drifted by the size of the
correction.

**The step column goes.** Model spend is recorded per call on `agent_messages`, which carries a
task class and no node id — the run is the unit, not the step. Splitting one run's cost across
its steps would mean choosing a rule (evenly? by duration? by tool?) and printing the answer as a
measurement. Nothing reads it and nothing can honestly write it, and a column that would have to
be guessed is worse than no column: the reader cannot tell a measured zero from an invented one.

**The page says the number, and says why it is what it is.** A run reads `no model spend`, and the
panel says once that a workflow is a graph somebody read back and activated, so it asks a model
nothing — and that a run showing spend has a step that called one. A bare `£0.0000` on every row
would read as a figure nobody measured, which is exactly the thing this change is fixing.

## The guard that had a hole in it

The trigger first carried the two-trigger split introduced in ADR 0057: recompute on insert, and
on update only `WHEN (NEW.agent_run_ids IS DISTINCT FROM OLD.agent_run_ids)`.

A test written to prove the number was the database's found the hole in one line.
`SET agent_run_ids = agent_run_ids, cost_cents = 4000` is not a distinct array, so the guard
declined to fire and the invented number stuck.

The split is for rules that **refuse** — a guard narrowed to the arriving value, so a later edit
over some other column is not turned down for a fact it never touched. This trigger refuses
nothing; it computes. **The gap in a derived column is exactly where somebody writes the column
without touching its inputs**, so it recomputes on every update, with no `WHEN` at all. That also
makes the roll-up safe: its `UPDATE` re-enters the same function and arrives at the same sum,
because both read the same array.

## Consequences

- A workflow run's cost is now a fact about its agent runs rather than a stored zero nobody
  maintains, and application code cannot claim otherwise — writing the column directly is not
  refused, it is overruled.
- The workflow page shows what a run cost, for the first time.
- `workflow_runs.cost_cents` leaves the queue and `workflow_step_runs.cost_cents` leaves the
  schema: **94 → 92**.
