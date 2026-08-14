# ADR 0014 — A schedule is a row, evaluated in the company's timezone, and a missed firing is a fact

**Status:** accepted · **Date:** 2026-08-14

## Context
Until now a workflow ran when somebody ran it. Making the worker fire schedules is a small
amount of code and a large amount of ways to be quietly wrong:

- a cron evaluated in UTC, or in server local time, fires "every weekday at 9" at the wrong
  hour for half the year — the same class of bug the spec calls out for "today" and
  "overdue" (§2.4);
- a daily schedule evaluated by walking clock time fires twice on the morning the clocks go
  back, and not at all on the morning they go forward;
- a worker that was down overnight wakes up and fires twelve hours of missed runs at
  somebody;
- two workers both decide it is their turn;
- a workflow stops firing — because its approvals are never decided, or its cap is spent —
  and nobody finds out until a customer asks why nothing happened.

## Decision

**The schedule is a row, and it is created by activation.** `schedules` has existed since
migration 0007 and nothing wrote to it. Now `activateWorkflow` writes it, pausing disables
it, and *editing* disables it — an edited workflow returns to draft, and a draft that kept
firing on its old schedule would be firing a version nobody dry-ran.

**Cron is evaluated in the schedule's timezone, a whole local day at a time.** The date
fields select local calendar days; the time fields are then resolved to an instant with the
existing `zonedTimeToUtc`. That gives exactly one firing per matching local day across a
daylight-saving change — the property a per-hour scan gets wrong in both directions. The
timezone comes from the organization, not the process.

**The dry run and the scheduler share one implementation.** `countFirings` delegates to
`occurrencesBetween`, the same function `nextOccurrence` is built on. A prediction computed
a different way from the thing it predicts is not a prediction.

**Claiming advances the schedule in the same transaction**, with `FOR UPDATE SKIP LOCKED`.
Two workers divide the due schedules between them; neither sees the other's rows and
neither can fire the same one twice.

**Catch-up is a policy on the row, and what it drops is counted.** `run_once` (the default)
fires once however many were missed; `skip_missed` gives up on a firing more than ten
minutes late; `run_all` catches up to five and reports the rest. `schedules.skipped_total`
and `last_skipped_reason` are columns, shown on the workflow's page — so "it has been
skipping since Tuesday, because the last batch is still waiting for approval" is a
question the interface answers.

**Unattended work is bounded by numbers a person set, checked against what happened.**
Before a scheduled run starts, `checkCapacity` counts this workflow's unfinished runs
against `max_concurrent_runs` and today's successful tool calls against `daily_action_cap`
— both from rows, not from a counter that resets when a process restarts. A run held back
is a `cancelled` workflow run carrying the reason, so it appears in the run list rather
than only in a log.

## Consequences
- An automation that stops working says so, on its own page, with the reason.
- Approvals cannot pile up: a workflow whose last batch is undecided does not queue
  another. The cost is that ignoring approvals stops the automation — which is the correct
  incentive.
- `run_all` can still produce up to five runs at once. That is bounded and logged rather
  than unbounded and silent.
- Schedules are minute-granular and the worker sweeps every minute by default
  (`WORKER_SCHEDULE_MS`). Sub-minute schedules are not supported and are not wanted.
- The cron grammar is the five standard fields with `*`, lists, ranges and steps. Nothing
  parses `@daily`, `L`, `W` or `#`; a spec that does not parse is refused when the schedule
  is written rather than silently never firing.
