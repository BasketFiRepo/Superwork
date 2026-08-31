# ADR 0090 — A workflow that runs when something happens

**Status:** accepted · **Date:** 2026-08-31

## Context

A workflow could run on a clock, or when somebody pressed a button. That was the whole list.

`WorkflowGraph.trigger.kind` has offered three values since Phase 3 — `schedule | event | manual` —
and `activateWorkflow` read:

```ts
if (trigger?.kind === 'schedule') { schedule = await upsertSchedule(...) }
```

with no `else`. A workflow whose trigger was an event therefore got `status = 'active'`, a
`published_at`, an audit line saying **workflow.activated**, and a row on the screen badged active
— and nothing would ever fire it. The workflow detail page told it, in as many words: *"It runs
when somebody runs it. Give it a schedule and the worker will fire it."*

It was not reachable, and that is the reason to build it rather than the reason not to. The only
path to a graph is `compileWorkflow(description)`, and the **mock** compiler emits `schedule` or
`manual` only. The day `AI_MODE=live` puts a real model behind that compiler, it will emit
`'event'` — it is right there in the interface it is filling in — and activation will accept it
silently. This is ADR 0088's lesson arriving before the bug does: the branch is safe today only
because the mock is narrower than the contract, which is not a property anybody is maintaining.

Three dead things in the schema turned out to be one unbuilt feature:

| Where | Since | What it says |
|---|---|---|
| `events`, all seven columns | 0005 | *"Internal event bus log. Workflow triggers and watchers read from here."* |
| `workflow_runs.trigger_payload`, `is_replay`, `run_depth` | 0007 | what fired a run, whether it is a re-run, how deep the chain |
| `trigger.kind = 'event'` | Phase 3 | no producer, no dispatcher |

`run_depth` is the tell. Somebody had already worked out that a workflow causing a workflow is the
hazard, named the column for it, and stopped.

## Decision

### A trigger that cannot be honoured stops the activation

Not a warning and not a fallback to manual: `activateWorkflow` refuses, naming the event names that
exist and the two ways out. This is the shape of ADR 0088's mode refusal, one layer in, and for a
sharper reason. A capability in the wrong mode does the wrong thing loudly enough to be found. An
automation that never fires produces *nothing at all*, and nothing is the same thing a correct
automation with no work to do produces. Silence is the one failure mode an automation cannot
report, so it has to be refused at the only moment somebody is watching.

The compiler refuses in the same direction. A sentence that clearly asks for a trigger — *"when a
contract is signed…"* — naming a moment nothing raises is `unsupported`, not silently compiled as
manual. Handing somebody a button when they asked for an automation, with nothing saying so, is the
worst outcome available.

### The event decides *when*, not *what*

An event-triggered run executes the same compiled graph a scheduled one would: it runs the
version's query and acts on what comes back. The event is recorded in `trigger_payload`, so "why
did this run happen" is answerable from the run alone — the same question ADR 0053 answered for
steps — but it does not narrow the query.

That is a real limit and it is deliberate. Making the event scope the work needs the safe query
layer to accept an entity, which is a larger change than this one; half-doing it would put a filter
in the dispatcher that the studio's readback does not know about, so the graph a person approved
and the work actually done would differ.

### The dispatch record lives on the run, not on the event

There is no cursor and no lease. An event-triggered run keys itself `version:event:<event id>`
against the unique index that has been on `workflow_runs (organization_id, idempotency_key)` since
0007, so a workflow that has already run for an event **cannot** run for it again — the second
insert is a unique violation, not a decision. Two workers racing settle it in the index; a worker
that dies mid-sweep loses nothing, because it had claimed nothing.

A cursor would have been the obvious design and is a second piece of state that can be silently
wrong — ahead of what it claims to have dispatched, and therefore skipping. The cost of not having
one is that a sweep re-examines events it has already handled: one indexed lookup each.

### Depth is derived from the trace, not threaded through

A workflow run opens a trace and `withTenant` carries it into everything the run does, so an event
raised *by* a run is already marked with which run raised it. `causeDepth` joins the event's trace
to the run that owned it and adds one. Nothing had to thread a counter through the tool layer,
which is why this keeps working for effects nobody has written yet.

The ceiling is three. The hazard is not hypothetical: `create_task@v1` is one of two actions the
compiler can emit and `task.created` is one of three events it can subscribe to, so **one sentence
can build a workflow that triggers itself.**

### Why a fourth log

Three already exist and none of them is this one. `audit_logs` is who did what, kept because
somebody may have to answer for it — and nothing may consume it, because a log that changes
behaviour is a log somebody has a reason to shape. `activity` is phrased for a person to read.

`outbox` is the near miss, and the difference is the one that matters: a row there is **one intended
delivery**, carrying `status`, `attempts` and `next_attempt_at` because exactly one thing must
happen to it. An event does not know who cares — nought, one or five workflows may be subscribed —
and per-subscriber progress cannot live on a row shared between them. Fanning out from the outbox
would mean giving one row several independent fates.

### A replay is a person's decision

`is_replay` marks a run against an event that was already offered, or was never offered because the
workflow was activated after the thing happened. It is deliberately not something the sweep does on
its own: a dispatcher that reached back after an outage would be a product that suddenly acts on a
day of history nobody re-read.

## Consequences

- `EMAIL`-shaped automations become possible at all: a workflow can run when correspondence
  arrives, when a task is opened, or when an approval is decided.
- Ten columns gain writers and readers — the whole of `events`, and the three on `workflow_runs`.
  Detector: **50 → 40**.
- `EVENT_DEFINITIONS` lives in `@superwork/config`, because the compiler is in `@superwork/ai` and
  the gate and the emitters are in `@superwork/core`, which already imports `ai`. That makes it a
  second place a fact lives beside the `events_name_known` CHECK, so a test asserts the two against
  each other — the same shape as ADR 0022's flags and ADR 0088's `LIVE_IMPLEMENTED`.
- Event-triggered runs go through `checkCapacity` unchanged, so the plan allowance, the concurrency
  limit and the daily action cap all still bound them. The compiler says out loud that an event
  trigger runs once per event, because on a busy day that is far more often than a schedule.
- Not fixed: the event does not narrow the query, and `emitEvent` swallows its own failures rather
  than failing the work that raised it. A lost event costs one dispatch; the time-windowed sweep
  means it cannot stall the ones after it.

## Lesson

`run_depth` was in the schema before there was anything to be deep. So was `trigger_payload`, and
so was a table with a comment naming the two consumers it never got.

ADR 0089 said an empty column with a good name is not a design waiting to be finished. This is the
larger version: an empty *table*, with a comment explaining precisely what would read from it, sat
through four phases of review. The comment is why. Every reader arrived at `events`, read that
workflow triggers and watchers read from here, and moved on satisfied — the note answered the only
question that would have exposed it.
