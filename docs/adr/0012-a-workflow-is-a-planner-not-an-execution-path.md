# ADR 0012 — A workflow is a second planner, not a second execution path

**Status:** accepted · **Date:** 2026-08-14

## Context
Natural-language authoring (§10.3) needs something to run the compiled DAG. The runtime
already executes plans: Intake → Ground → Plan → Gate → Act → Observe → Reflect → Report →
Persist, with an approval in the middle and an undo ledger at the end.

Three options were available.

1. **Reuse the agent runtime.** Turn each workflow node into a request and let the model
   plan it. Everything is inherited for free — but the model re-plans on every firing, so
   the same workflow does slightly different things on Tuesday, and the dry-run story
   ("this would have fired 22 times and done *this*") stops being a prediction.
2. **A standalone executor.** Fast, deterministic, and a completely separate road to a
   side effect — its own permission checks, its own approval shape, its own audit rows.
   That is the anti-pattern: two ways to change the database means two places for a
   permission bug, and "undo it" means one thing here and another thing there.
3. **A deterministic planner in front of the existing machinery.**

## Decision
**The DAG replaces the planner, and nothing else.** A workflow node maps to a tool call
through explicit per-tool mapping; from that point the call goes through the *same*
registry, the *same* `can()`, the *same* `preview()` on the *same* approval card, the
*same* `tool_calls` row and the *same* `undo_operations` ledger as an agent run.

**A live workflow run owns an `agent_runs` row.** `workflow_runs.agent_run_ids` existed
in the Phase 0 schema for exactly this. Tool calls and undo entries hang off it, so
"undo what that automation did" is the same operation as "undo what the agent did", and
the AI ledger counts a workflow's cost without a special case.

**A row is never passed to a tool wholesale.** Each node type maps named columns to named
arguments. A column that arrives from a query is not an argument a person approved, and a
tool that accepted the row would accept whatever a future query added to it.

**Actions are prepared, then applied.** The walk collects planned calls and their previews;
an `approval` node raises one approval carrying all of them and stops the run. That keeps
the plan the unit of approval — an approver sees the whole blast radius, not one call at a
time — and it is what lets an approver's edit reach the call before it happens.

**The dry run separates what is counted from what is projected.** Firings are counted by
walking the schedule over the window. Effects are what one firing would do against the data
as it stands now. The sentence reports both and multiplies neither, because
firings × today's matches is a number nobody measured.

## Consequences
- A workflow does the same thing every time it runs, which is the property that makes a
  dry run worth anything.
- The compiler is the only place that decides what a sentence means, so widening what
  workflows can do is a change to one file with tests, not a prompt.
- Effects are bounded twice: `MAX_ITEMS_PER_RUN` in the executor and `daily_action_cap` on
  the row.
- What the executor cannot express, it refuses to compile. That is deliberate: the failure
  mode of a permissive compiler is an automation nobody can predict, and this product's
  whole claim is that you can.
