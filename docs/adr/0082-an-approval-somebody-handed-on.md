# ADR 0082 — An approval somebody handed on

**Status:** accepted · **Date:** 2026-08-24

## Context

`approvals.delegated_to` has existed since migration 0005 with no writer and no reader.
`ApprovalStatus` has carried `'delegated'` for just as long — a state the type system offers and
no code path can produce.

The module around it is the most carefully built thing in this codebase. `decideApproval` enforces
the policy's named role, refuses a rejection with no reason, checks edits against what the card
actually offered, and blocks self-approval on the **requester** rather than the assignee. The one
thing it cannot do is the ordinary thing: the person an approval is waiting on is away, and there
is no way to say so. `ApprovalView` already computes `hoursWaiting`, so the product knows the card
is ageing and has nothing to offer but waiting longer.

## Decision

**Delegation names who should decide. It never widens who may.**

That is the whole security shape of it. A hand-off that granted authority would be a
permission-transfer mechanism with a friendly button on it — the thing `assertEditsAreOffered`
already refuses one version of. So every rule `decideApproval` applies to a decider is applied
here to the **delegate**, in advance:

- they must be able to decide approvals at all;
- they must satisfy the policy's `approverRole`, or a manager-only card gets cleared by somebody
  who could not have cleared it directly;
- and they must never be **the person who asked**.

That last one is the route around §11.3 nobody would notice: hand the card to the requester, and
the self-approval rule is satisfied by the delegator's name while the requester clears their own
request. It is refused in the repository with a sentence saying why, and again by a CHECK, because
the two places disagree only in which of them somebody bypasses.

The delegator is held to the same bar — **you cannot pass on a decision you could not have made**.
That is the ceiling this build has now drawn four times: tighten, never exceed.

**A reason is required**, unlike the attendance record in ADR 0081 which deliberately refused one.
The difference is who the sentence is about. "I am on leave until the third" is a statement about
your own availability; "why Ruth was absent" is a note about Ruth. An approval that moved with no
explanation is also the shape of one moved until it found a friendlier answer.

**The picker offers exactly what the repository accepts.** `handOverCandidates` asks the same
questions `delegateApproval` will ask, so the control cannot list somebody the server will refuse —
the idiom ADR 0065 established for confirming decisions. A test hands the card to *every* name the
picker offers and asserts none is refused, so the two agree rather than merely look alike.

**Taking it back** clears the attribution with it. A row should not name a hand-off that is no
longer standing.

## The status that was never the right model

`'delegated'` sat in the enum among `approved`, `rejected`, `expired` and `cancelled` — the states
in which nothing more is waiting. But an approval somebody handed on is still **pending**: no
decision has been made, and the queue showing open work has to keep showing it. Anything reading
`status = 'pending'` to mean "still open" would have silently dropped every handed-on card.

The column says whether a decision has been made. `delegated_to` says who it is waiting on. Those
are two different facts, and `'delegated'` is the second written into the field that holds the
first — **it could not be set without making `status` unreliable.** It was not unreachable by
accident. It was unreachable because reaching it would have broken something.

So it is removed, from the Postgres enum and from the TypeScript union. Postgres cannot drop an
enum value, so the type is rebuilt; nothing held `'delegated'` and nothing ever could, so the cast
cannot lose a row.

## Three bugs the tests found, all mine

**A CHECK that passed on NULL.** `approvals_delegation_attributed` ended in
`length(btrim(delegation_reason)) >= 8`. With the reason NULL that expression is NULL, and **a
CHECK passes when its expression is TRUE or NULL** — so the constraint accepted exactly the row it
was written to refuse: handed on, attributed, no reason given. Every assertion made *through the
repository* passed, because the repository checks the reason itself before the database sees it.
Only the test that writes the row directly could find it. `delegation_reason IS NOT NULL` is now
written out, and it is the whole constraint.

**A migration that narrowed a control while adding to it.** The notification for the delegate needs
a new type, and `notifications_type_known` is a closed list. The first draft reproduced 0030's
original five values and appended one — but five migrations have extended that constraint since,
and the live list has ten. Applying it would have refused every `disclosure` the transparency layer
writes. The rollback failing on existing rows is what surfaced it. The list is now carried forward
and added to.

**A trigger that refused its own undo** — nearly. The `IS NOT NULL` guard leading the update
trigger's WHEN clause is there because ADR 0081 shipped that exact bug a day earlier: clearing an
attribution fires the trigger with a null name, finds no membership for nobody, and refuses. Taking
a delegation back would have been impossible. Written correctly the first time here only because
the previous increment got it wrong.

## Consequences

- An approval can be moved when the person holding it is away, with both names and a reason on it.
- Delegation cannot escalate: every delegate could already have decided the card.
- The requester can never be handed their own request.
- `approvals.delegated_to` comes off the detector's queue — **73 → 72** — and a status the type
  system offered but the product could never produce goes with it.
- A new notification type, added in all three places it has to exist: the CHECK, `NOTIFICATION_TYPES`
  so a preference can be set before the first one arrives, and the label the reminders screen
  renders it by.

## Lesson

The column was empty for the ordinary reason. The **enum value** was empty for a much better one:
setting it would have broken the field it lived in.

An unreachable state is usually a feature nobody wrote. Sometimes it is a design that was tried,
found to contradict itself, and abandoned in place — and the way to tell is to work out what would
have had to be true for something to set it.
