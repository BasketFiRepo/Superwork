# ADR 0083 — An insight you can put off, and one you can finish

**Status:** accepted · **Date:** 2026-08-24

## Context

The insight lifecycle is further built than the detector's output suggests. `acknowledged`,
`in_progress` and `dismissed` all have controls on the card, and dismissal takes one of four
reasons that feed `watcherQuality` — a watcher people keep calling wrong is muted automatically.

Two states had no control, and one column had neither a writer nor a reader.

**`snoozed_until`** has existed since migration 0006 and nothing has ever written it. `'snoozed'`
had no control, and nothing would have brought an insight back if it did.

**`'resolved'`** was in `FeedbackInput`'s union and on no button. So the only way to close an
insight the watcher got **right** was to dismiss it — and dismissal is a verdict on the watcher.
The product has been asking people to slander a watcher for being useful, and then reading the
result as evidence about its quality.

That second one is the finding. It is not a missing feature; it is a feedback signal being fed
its own absence.

## Decision

**A snooze that never ends is a dismissal that lies about itself**, and it lies in the direction
that damages the watcher. So the deferral and the return are built together or not at all.

`snoozeInsight` sets the status and the date; `sweepSnoozedInsights` runs in the worker on the
same pass as the follow-up sweep and brings them back. Neither exists usefully without the other,
which is why `'snoozed'` is **removed from `FeedbackInput`'s union**: the feedback route has no way
to carry a date, and a status accepted without one would be an insight nothing ever returns.

**It comes back to `acknowledged`, not to `new`.** Somebody saw this one and decided when to look
again. Sending it back to `new` would say nobody had ever read it — the sort of small lie a badge
count is built on.

**Thirty days is the cap.** Past that a deferral is a dismissal wearing a date, and dismissing says
something the watcher can learn from.

**Only `new` or `acknowledged` can be put off.** Work already under way is finished or abandoned;
offering snooze there would make `in_progress` a place things go to be forgotten with a date on.

**No reason is required, and that is the opposite call from ADR 0082.** Delegation demands one
because moving an approval is consequential and unexplained movement is the shape of shopping for
an answer. Dismissal demands one because it is a verdict on the watcher. A snooze is a verdict on
the *timing* — and demanding an explanation to say "not this week" is friction pointing straight
at the dismiss button, which would quietly corrupt the one signal watcher quality is built on.
The friction has to sit where the consequence is.

**And it can be brought back early.** This was missing from the first draft, and the browser
check's *second* run is what argued for it: the beat put the demo's only insight off, and the next
run had nothing to act on, because the watchers dedupe against the one still sitting there. That is
a test-shaped symptom of a product-shaped hole — every other deferral here can be undone, a
delegation taken back and an attendance record unrecorded, and the sweep that would otherwise
release this one is up to a month away. `until` absent on the same route brings it back, the way
the delegation route reclaims.

**Deferred is a third bucket on the screen**, not part of "closed". A snoozed insight filed under
resolved-and-dismissed is one somebody believes was dealt with, and it is going to come back.

## What the database keeps

`status` and `snoozed_until` are two places holding one fact, so the database keeps them in step
rather than trusting every future caller: `CHECK ((status = 'snoozed') = (snoozed_until IS NOT
NULL))`. Both sides are NULL-safe — `status` is NOT NULL and `IS NOT NULL` never yields NULL —
which matters, because ADR 0082 shipped a CHECK that passed on NULL and accepted the exact row it
was written to refuse.

A snooze must end in the future, enforced by a trigger rather than a CHECK for the reason
`logInteraction` already gives: a constraint cannot call `now()`, and a row legitimate when written
must not turn invalid as the clock passes it — which is precisely what a snooze does. Split across
insert and update (ADR 0057), with `IS NOT NULL` leading the update guard, because the sweep
*clears* the date to bring an insight back and without it that clear would be refused against
`now()`. That guard is here first time only because ADR 0081 shipped the bug.

And the name on it belongs to this organization — the fourth writing of the rule after
`sw_agent_budget_setter_same_org`, `sw_attendance_setter_same_org` and
`sw_approval_delegation_same_org`.

## A number the product already answers better

`insights.confidence` is dropped. It is the watcher's own guess at whether it is right, defaulted
to 0.8 and set by nothing. The product already answers that question and answers it from evidence:
`watcherQuality` measures what people actually did with a watcher's output and mutes one that keeps
being wrong. A self-reported score beside a measured one is the same fact kept twice, and the two
would disagree in the direction that flatters the watcher.

## What was looked at and left

**`'expired'`** remains unreachable. Unlike ADR 0082's `'delegated'` it is not self-contradictory —
it is a feature nobody has specified, and there is no honest generic answer to "when has an
observation stopped being true". Retention already removes old insights. Recorded here so the next
person does not rediscover it as a finding.

## Consequences

- An insight can be put off without a lie being recorded about the watcher that raised it.
- An insight the watcher got right can be closed as right, so `watcherQuality` stops being fed
  dismissals that meant "thank you".
- The detector's queue: **72 → 70** — `snoozed_until` gains a writer and `confidence` goes.
- A second new notification type this week, added in all three places it has to exist.
- Worth recording for the next increment: `pnpm typecheck` **cannot** see `apps/web` — the root
  tsconfig excludes it and Next typechecks it with its own config. A web-only type error is
  invisible until `pnpm build`, which is where one in this change surfaced.

## Lesson

ADR 0082's lesson was that an unreachable state can be a design that contradicted itself. This is
the third kind: **a state that was unreachable because the state next to it was doing its job
badly.** Dismissal was absorbing every close, snooze and shrug, and the damage was not to the
insight — it was to the measurement built on top of dismissal.

A missing control is worth finding. A missing control whose absence is being *counted as data* is
worth finding first.
