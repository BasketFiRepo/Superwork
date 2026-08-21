# ADR 0065 — A decision somebody stood behind

**Status:** accepted · **Date:** 2026-08-21

## Context

`decisions.confirmed_at` and `decisions.confirmed_by` have existed since migration 0010.
Nothing has ever written either. Two screens read them:

- **The decision log** on `/meetings` renders a **Confirmed** column as `yes` or `not yet`. It
  has said `not yet` for every row since Phase 1 and always would have.
- **The meeting page**'s decisions panel is subtitled *"Recorded from the transcript — confirm
  anything that reads wrong"*: an instruction pointing at a control that does not exist.

What makes the gap worth closing rather than deleting the columns is where the rows come from.
`recordDecision` is called from exactly one place — the agent's meeting summarizer. Every
decision in the log was read out of a transcript by a model, carries the `confidence` it had
(0.78, 0.84, 0.91) and an `agent_run_id`. So the decision log is a list of the assistant's
readings of what was said, presented as the record of what was decided, with no way for
anybody who was in the room to say yes.

`memory_facts` already answers this exact question, and its answer is in the code: *"an agent
actor is refused here because an assistant confirming its own observation is how a wrong
inference becomes the foundation of every later answer."* The decision log had the same
problem and none of that machinery.

And one more thing found in the same function: **`listDecisions` took no actor and made no
permission check of any kind.** RLS kept it inside the organization and that was the entire
gate, on a list of what was decided in meetings — commercial terms, pricing, personnel. Every
comparable list here takes an actor, asks `grantedScope`, and filters by clearance.

## Decision

**A confirmation is a person's, or it is nothing.** `setDecisionConfirmation` writes
`confirmed_by` and `confirmed_at` together, and refuses an agent actor by name with the reason
rather than a generic denial. The assistant proposes; it does not also agree.

**Being in the room comes first.** A participant or the organizer of the meeting a decision
came from may confirm it *whatever their role* — a member holds no `project:update` at all, and
is exactly the person who can say whether a transcript was read correctly. Somebody with a say
over the project may confirm too, because a decision filed against a project is part of that
project's record and there has to be a route when nobody who attended is still here. The
refusal names both routes, so it says what would work.

**Confirming asks for no reason; withdrawing does.** A confirmation affirms text that is
already on the screen — the decision is its own reason. A withdrawal says the standing record
is wrong while leaving it in place, so the next person to read it needs to know what the
signature knew. The decision itself is never edited or deleted by either act.

**One signature, not a pile.** A second person confirming is refused, naming who holds it.
Two names on one line would say less than one, not more: "who is answerable for this" has one
answer or none.

**The database keeps the shape.** `decisions_confirmation_attributed` refuses half a
signature — a `confirmed_at` with no name is a claim that somebody agreed without saying who.
`sw_decision_confirmer_same_org` refuses a signature from another tenant, because a foreign key
to `users` says the person exists and nothing about which organization they are in.

**The list asks who is reading it.** `listDecisions(ctx, actor, filter)` now gates on
`project:read` and drops rows whose project is above the reader's clearance or outside their
scope, decided by `canReadProject` — the same call `listProjects` makes, exported for this so
two places cannot disagree about a project a person may not read. A decision on no project has
nothing narrower to be judged by and stands on the organization-level gate. `getDecision`
answers a refused row with 404, never 403.

**The assistant is told the difference.** `list_decisions@v1` returns `confirmed` and
`confirmedBy` alongside each summary, takes an `unconfirmedOnly` filter, and its description
says what to do with them: *quote an unconfirmed one as something the transcript appears to
say, never as something the company decided.* This is the payoff. Without it the model reads
its own past extractions back as established fact, which is the loop the memory system was
built to prevent and the decision log had no equivalent of.

## Why the CHECK is validated when the last three were not

Migrations 0054, 0056 and 0057 all added `NOT VALID` constraints, and a reader will expect a
fourth. Those added their attribution columns in the same migration, so the down script drops
the columns and a re-apply over live data would meet rows the constraint could not be made true
of. These two columns are 0010's; the down script leaves them and their signatures where they
are, so there is no such row — every existing decision has both `NULL`, which satisfies the
constraint. A constraint that can be validated should be.

## What this does not do

**It does not make confirmation compulsory.** An unconfirmed decision is still a true record of
an extraction, and saying so is more honest than hiding it or refusing to store it. What
changes is that the screens and the tool now say which kind of thing they are showing.

**It does not let a confirmation edit the decision.** "That is not what we decided" removes a
signature and says why; correcting the text is a different act with different consequences for
everything downstream, and inventing it here would have been the easy version of this.

**It does not seed a confirmed decision.** The demo gains four decisions read from the
transcripts it already had — the decision log was empty, which is a strange state for "the most
valuable and most neglected artifact in project work" — and every one starts unconfirmed,
because that is the state every decision starts in.

## Consequences

- The **Confirmed** column stops being a column that could only say `not yet`, and names the
  person instead.
- The panel that told people to confirm things now has the control it was describing.
- The decision log header says how much of itself is still an assistant's reading:
  *"4 of 4 still an assistant's reading of a transcript"*.
- The `list_decisions` tool cannot hand the model an extraction that looks like a settled fact.
- A member who was at a meeting can confirm a decision they hold no write permission over,
  which is the first time being in a room means anything in the permission model.
- `decisions.confirmed_at` and `confirmed_by` come off the detector's queue: **103 → 101**.
