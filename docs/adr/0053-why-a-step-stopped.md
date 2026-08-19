# ADR 0053 — Why a step stopped

**Status:** accepted · **Date:** 2026-08-19

## Context
`workflow_step_runs.error` is selected by `listWorkflowRuns` straight into the run detail screen,
and no code path had ever written it. That was the smaller half.

The larger half was in the executor. The `try` sat around the whole walk rather than around each
node, so when a node threw, the run was marked failed with the message and **no step row was
written for the node that threw**. A person reading a failed run saw four steps that succeeded, a
run marked failed, and nothing saying which step was the one — they had to infer it from the run's
own sentence, which names the error and not the node. On a five-node graph that is a guess.

Two more columns on the same table had the same shape. `duration_ms` was declared and written by
nothing, so a slow run could not say which step was slow. And the run's failure class was
hardcoded: every workflow failure was recorded as `'tool'` — a value that is not even in the
`FailureClass` taxonomy — while the error being caught already carried its own class. A refusal, a
missing row and a budget were all filed as tool trouble.

## Decision

**The `try` moves inside the node loop.** The node that throws writes its own row, with
`status = 'failed'`, the reason, and how long it had been running, and then the error is re-thrown
so the run still fails exactly as before. Nothing about the run's own outcome changes; what
changes is that the record now contains the step that ended it.

**A failed step says why, and the database holds that.**
`CHECK ((status = 'failed') = (error IS NOT NULL AND length(btrim(error)) >= 3))` — both
directions. "It failed and we do not know what happened" cannot be stored by anybody, whatever
the executor does next; and a reason cannot drift onto a step that is fine, which would read as a
failure on a screen that shows one.

**`detail` and `error` mean different things.** `detail` says what the step *did* and is written
for every step. `error` says why it failed and exists only on a failure. They were one field
before, in the sense that a failure had neither.

**The status column is pinned to the words the executor uses.** It was free text with a default of
`'queued'` — a status no step is ever written in, because rows are inserted once, after the work,
in their final state.

**The failure class comes from the error.** `SuperworkError` carries a `failureClass` because the
UI copy differs per class (§5.6); the executor was throwing that away. It now uses the error's own
class, and `'internal'` for anything that is not one of ours — which is honest about a bug rather
than calling it a tool failure.

**One way of writing a duration.** The run detail and the trace rail both say how long a step
took. The shared formatter lives in the web app's `lib`, not in `@superwork/core`, because a
client component that imports from core pulls `node:crypto` and `node:fs` into the browser bundle
— the build says so, loudly, and it is right.

## What is deliberately not built

**`workflow_step_runs.cost_cents` and `workflow_runs.cost_cents`.** Both are declared, default to
zero, and are written by nothing. Cost is metered per model call in `usage_records`, which is what
the spend snapshot, the budget gate and the ledger all read (ADRs 0028, 0040). Attributing the
same money to a graph node as well would be a second place counting it, and the two would
disagree the first time a step made two calls or none. When a per-step figure is genuinely wanted,
it should be derived from `usage_records` by run and step rather than written again here.

**Retrying a failed step.** The record now says which step stopped and why, which is what a person
needs in order to decide. Re-running one node of a graph in isolation is a different feature with
its own questions about what the nodes after it should see.

## Consequences
- A failed run's step list ends with the step that failed, in red, with the reason on it — and the
  run's own sentence still says what happened, as it always did.
- Every step records how long it took, including the ones that failed part-way.
- An agent run started by a workflow now carries the real failure class, so the run list can
  distinguish a refusal from a bug without reading the prose.
- Eight tests, and the acceptance loop, break the graph on purpose — the query node is pointed at
  an aggregate that does not exist, which `runAggregate` refuses — and put it back. Reverting the
  per-node `try` fails three of them.
