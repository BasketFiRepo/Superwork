# ADR 0033 — A reminder has to arrive somewhere, and the answer has to mean something

**Status:** accepted · **Date:** 2026-08-15

## Context
The nudge ladder (§29.2) is one of the load-bearing accountability features: five rungs, a
per-person daily budget shared across every agent, an audience per rung, and a manager
escalation that a co-determined jurisdiction switches off entirely. All of it existed. Three
things were missing, and together they meant none of it had ever happened outside the
acceptance loops.

**Nothing ever opened a ladder.** `scheduleLadder` was called by the two loops and by
nothing in the product. The worker's nudge pass therefore ran on an empty queue on every
tick since Phase 4.

**Nothing could receive one.** Rungs four and five are declared `channel: 'in_app'` and
there was no in-app anything. Every delivery also wrote a `notifications` row — a table
written by four subsystems (the nudge worker, a workflow's notify node, task-dependency
unblocking, the agent's "needs a decision" tool) and read by exactly two: retention, to
delete it, and erasure, to delete it. And because `postToChat` degrades to `in_app` when no
chat integration is connected — the default, since the product runs with zero credentials —
**every reminder the product could send would have landed nowhere and been recorded as
delivered.**

**The answer meant nothing.** `respondToNudge` has five actions under a comment reading
*"One action closes it."* It wrote the word to the row and stopped: the task was untouched,
and the due query does not filter on `responded_at`, so answering rung one did not stop
rungs two to five. Somebody could say "done" three times and still be escalated to their
manager.

## Decision

**The product opens its own ladders.** `openLaddersForDueWork` sweeps open tasks with an
assignee and a date inside the ladder's window and lays out the rung that fits today.
Deliberately the dullest possible link — scheduling twice is already a no-op — and only
tasks: an approval and a commitment have their own screens with their own decisions on them,
and chasing somebody about one from here would be a second place to decide.

**Reminders arrive on a screen of the person's own.** `/reminders` shows what they were
sent, what the system told them, and how many times a day they can be contacted at all.
Undelivered rungs are absent on purpose: a ladder is laid out days ahead, and showing
somebody the three reminders they are *going* to get is a threat, not a reminder.

**Nobody but you can read it.** Not an admin, not your manager. A list of what somebody has
been chased about is a behavioural record of that person, and §29.5 does not allow one to be
assembled. A manager's rung-five escalation arrives as *their* reminder about one overdue
thing — which is the difference between accountability and monitoring. Answering somebody
else's reminder reports absence rather than refusal: whether a colleague was chased is not a
fact this product will confirm.

**Each answer does what it says**, through `updateTask`, so the permission check, the version
and the audit entry are the ones the task screen uses:

| Answer | What happens |
| --- | --- |
| Done | the task is completed |
| Blocked | the task is marked blocked, with what was said as the reason |
| New date | the due date moves, and a **new ladder** is laid against the date the person chose |
| Somebody else | the task is reassigned, and the chasing follows the work rather than the person who handed it over |
| Not yet | nothing changes, and the screen says the ladder still runs |

Answering also calls off the remaining rungs — except a snooze, which is the one answer that
means "keep asking". The order inside `answerReminder` is load-bearing: record the answer,
*then* cancel the rest (so the rung being answered is not swept up with it), *then* apply the
effect (so a renegotiation's new ladder is not cancelled a line after it is created).

**A rung about somebody else's work records the answer and touches nothing.** Rungs four and
five go to the person waiting and to the manager; letting either close a task that is not
theirs would turn a notification into a remote control.

**Only the preferences something reads are settable.** `notification_preferences` has been
read by the briefing scheduler since Phase 2 and written by nothing but the seed, so
everybody had the default hour and no way to change it. The three fields it reads are now
editable; `quiet_hours` is displayed as stored-but-not-honoured with a *Coming soon* tag,
because a control that changed a number nobody consults is the fake integration §25 forbids.

## Consequences
- The worker now opens ladders before delivering. On a real deployment with overdue work this
  will start contacting people — inside the per-person budget, which is exactly the control
  that exists for it, and every contact is visible to its recipient on the day it happens.
- `respondToNudge` remains for the tool layer and is now the narrow write beneath
  `answerReminder`, which is what the screen and the API call.
- The badge in the sidebar counts unanswered reminders and unread notifications, and it is
  computed per request for the signed-in person only.
- Reminders about approvals and commitments render with a link and record the answer without
  changing anything, and say so on the row. That is a smaller promise than the ladder makes
  and it is stated rather than implied.
- The browser walkthrough now clears the organization's spend cap it sets earlier in the
  same run. It had been leaving the demo capped at a quarter of its plan, which surfaced as
  an unrelated failure three beats into the phase 5 loop.
