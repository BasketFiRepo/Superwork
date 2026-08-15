# ADR 0031 — A watcher that is right and unwelcome is not one that is wrong

**Status:** accepted · **Date:** 2026-08-15

## Context
Since Phase 3 the insight card has asked why an insight was being dismissed — *not useful*,
*wrong*, *already handled*, *not my job* — and written the answer to `insight_feedback`. The
route that wrote it carried this comment:

> Dismissal reasons tune future thresholds per organization and per user (§9.2).

Nothing tuned. Nothing read the table at all. Being asked a question implies the answer
matters, so asking into a void is worse than not asking.

Meanwhile a different signal *was* read. `mutedWatchers` counted `insights.status =
'dismissed'` and switched a watcher off above 70% over twenty insights. That treats four
different sentences as one:

- **wrong** — the watcher is producing false positives. Evidence against it.
- **not useful** — correct, and not worth anybody's attention. Evidence against it.
- **already handled** — the watcher was **right**; somebody had got there first. A *timing*
  problem.
- **not my job** — right, and sent to the wrong person. A *routing* problem.

A watcher whose every insight was real and already dealt with was switched off exactly as
fast as one that was making things up. The two failures that follow from that are opposite:
one leaves noise running, the other silently removes something that works. A muted watcher
is indistinguishable from a quiet one, so nobody would have noticed.

The route also had no permission check whatsoever. It took an actor and never used it, so a
`guest` — who holds no insight permission at all — could rate any insight and dismiss it for
the whole organization.

## Decision

**Reasons decide, and dismissal is the fallback.** `judge()` mutes on the share of *wrong*
and *not useful* alone. Below twenty ratings nothing is decided from what people said — a
rate computed from three votes is a guess with a percentage sign on it — and the old
dismissal rule still applies underneath, so a watcher thrown away repeatedly with nothing
said is still switched off. Removing a control while replacing it is how a refinement
becomes a regression.

**The other two reasons produce their own verdicts, not silence.** *Already handled* above
half reads `late` — run it earlier rather than switching it off. *Not my job* above half
reads `misrouted` — it is right and reaching the wrong people. Both are shown on the row
with the arithmetic behind them, because a watcher that stops needs to be explainable.

**One vote per person per insight**, enforced by a partial unique index. Once feedback
decides whether a watcher runs, unlimited votes is one person muting it on their own.

**Two permissions, checked before anything is written.** Rating needs `insight:read` — you
are commenting on something you were shown. Changing the status needs `insight:update`,
because dismissing takes it off everybody's screen. Both are checked up front: the first
version inserted the rating and *then* refused the status change, inside a transaction that
rolled the rating back, while telling the person their rating had been recorded.

**A refusal that names a next step offers it.** The card reads the failure class rather than
the prose and offers to record the rating without the dismissal. That needed the HTTP layer
to stop answering 400 for every domain error — `errorResponse` now maps permission to 403,
absence to 404 and conflict to 409, and carries the failure class in the body. A row in
another tenant throws `NotFoundError`, so cross-tenant access still answers 404 and never
403 (§3.2); the status now carries that distinction instead of flattening it.

## Consequences
- `mutedWatchers` is now a thin wrapper over `mutedWatcherReasons`. The sweep reports the
  reason a watcher was skipped rather than restating a threshold that is no longer the only
  rule.
- A workflow run now stores the compiled graph it is working from as the run's plan. It had
  one all along — the readback a person approved at activation — and stored nothing, so the
  compliance review's question *"for any action, can you show what was proposed beforehand?"*
  answered **no** for every action a workflow ever took. Found by running the phase-4 loop
  after the phase-5 loop rather than before it.
- Four acceptance-loop beats left the demo in a state they would not choose: a live legal
  hold, a published agent, a project share, and a confirmed memory citing a seeded document.
  Each is now put back, and the loops pass twice in a row on the same database — a property
  that had never been true and that nothing was checking.
- Feedback is not per-person tuning. The comment promised thresholds "per organization and
  per user"; only the organization's are read. A per-person threshold is a per-person
  behavioural profile, and §29.5 does not allow one to be built by accident.
