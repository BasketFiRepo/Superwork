# ADR 0066 — A promise that became work

**Status:** accepted · **Date:** 2026-08-21

## Context

`commitments.task_id` was added in migration 0010 and nothing has ever written it, while
`SELECT_COMMITMENT` reads it into every `CommitmentView` the product builds.

The ledger already had the hard half. A commitment is detected by the assistant from a message
or a transcript, sits as `proposed` until its named owner accepts it, and can then be confirmed,
disputed, renegotiated in advance, or completed — the distinctions §29.2 exists to draw. What it
never had was the work: you accept *"we will confirm the Gothenburg window by Wednesday"* and
there is no way to turn it into the task you would actually do it with. Then you mark it `kept`
by pressing a button, which is a claim about work that never existed anywhere in the system.

And the demo had no commitments at all, so the ledger screen — the one place §29.1 and §29.2 are
visible — showed five zeroes.

## Decision

**One promise, one piece of work.** `createTaskForCommitment` creates the task, points
`task_id` at it, and links the two rows with `resolves`. The task inherits the promise: its due
date, and the person who owns it as assignee.

**Four refusals, each naming what would work instead.**

- *A suggestion cannot be planned.* A `proposed` commitment has not been accepted, and creating
  work for it would be the product agreeing on somebody's behalf — the exact failure the ledger
  exists to prevent.
- *A promise somebody else made is not our work.* A `they_owe` commitment is discharged by the
  counterparty. A task about it is a chase, and finishing a chase would say they delivered when
  all that happened is that we asked. The refusal points at follow-ups, and
  `commitments_task_is_ours` refuses the row as well.
- *One promise, one piece of work.* A second task would leave two things both claiming to be how
  this gets done.
- *Nothing is planned for a promise that is already settled.*

**The task is the one writer that says the work is done.** Once a commitment has a task, two
rows have to agree — "the task is finished" and "the promise was kept" — and that agreement is
not left to application memory. `sw_commitment_kept_by_task` moves a `confirmed` commitment to
`kept` when its task completes, by trigger, so it holds for the agent's `complete_task` tool,
for the reminder that completes a task from a reply, and for anything added later that nobody
thought to teach about commitments. `respondToCommitment` refuses `complete` on a linked
commitment and names the task instead: two buttons that both mean "finished" is how a ledger
starts disagreeing with the work.

**Only `confirmed` moves.** A `disputed` commitment is not made true by somebody finishing a
task; one already `kept` has nothing to change; `proposed` never counted.

**Nothing moves the other way.** Cancelling the task does not unmake a promise made to somebody
outside this company. The promise stands, the ledger goes on saying so, and the person can
dispute or renegotiate it like any other — which are first-class answers here, not failures.

## The instrument broke, and this change broke it

`pnpm check:columns` went from 102 unwritten columns to **99** when this was first written,
which is two more than the one column this change fills. `email_accounts.status` and
`subscriptions.status` had silently left the queue.

The cause was in the detector, and the trigger was this migration. Its scan for trigger writes
matched `NEW.x :?=` — accepting `NEW.x =` as well as `NEW.x :=`. In plpgsql `:=` is assignment
and `=` is equality, so the pattern was counting reads as writes. That scan is deliberately not
attributed to a table (a trigger body cannot be tied to one by text alone), so a single
`FOR EACH ROW WHEN (NEW.status = 'completed')` in this migration credited a write to `status` on
all 96 tables that have one.

Every genuine assignment in every migration uses `:=`; every `NEW.x =` on disk is a condition —
`IF NEW.parent_id = NEW.id`, `IF NEW.sensitivity_source = 'human'`, and the new WHEN clause. So
the pattern is narrowed to `:=`, the scan is extracted as `triggerAssignments` so it can be
tested rather than reasoned about, and the queue returns to **101 → 102 minus this change's
one**. Reverting the regex alone fails two of the three new tests.

This is the fourth time the detector has been wrong (ADR 0060 recorded the first three) and the
first time it was wrong because of a change made in the same commit. The lesson is the same one
that put it in CI: an instrument that quietly agrees with you is worse than no instrument, and
the way to find that out is to watch what it says when you change something underneath it.

## Consequences

- An accepted promise can be turned into the work that discharges it, and finishing that work
  moves the ledger without anybody pressing a second button.
- The task page says which promise it keeps, read from the link rather than from the description
  the create wrote — a description is text somebody can edit.
- A commitment whose task was deleted says so: `taskId` set with no `taskTitle`. The promise
  stands.
- The demo gains five commitments taken from lines people actually say in the seeded
  transcripts — three we owe, one they owe, two already accepted in the room — so the ledger's
  five tiles stop reading zero.
- `commitments.task_id` comes off the detector's queue, and two columns that should never have
  left it come back.
