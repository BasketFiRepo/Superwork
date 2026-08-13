# ADR 0007 — A commitment belongs to the person who made it

**Status:** accepted · **Date:** 2026-08-13

## Context
Phase 2 detects promises in mail and in meeting transcripts: "I will send the revised
schedule by Friday" (§12.4, §29.1). Detection is the easy half. The damaging failure mode
is the other half — being chased by software for something you never agreed to, or having
a half-sentence from a meeting turn into an assigned task with a date on it.

Extraction is also unavoidably uncertain. A pronoun does not always resolve. A name said
out loud may belong to somebody who was not in the room. A politeness ("happy to help
where I can") is not an obligation. Any system that treats extraction output as fact will
be wrong often enough to lose the user's trust permanently, and the first wrong nudge
costs more than ten right ones earn.

## Decision
A detected commitment is written with status `proposed` and, in that state, it does not
exist as far as the rest of the product is concerned:

- it is excluded from the daily briefing's counts and from every rollup;
- it never triggers a nudge, an escalation, or a manager-visible signal;
- it cannot become a task.

Only its named owner — or a manager above them — may answer it, with `confirm`,
`dispute`, `renegotiate`, `complete` or `cancel`. Confirming is what moves it into the
ledger. Turning a confirmed action item into a task still runs through the ordinary
plan → approval → undo path rather than a second write path.

Where the owner cannot be resolved with confidence, the extraction records what was
literally said (`mentionedOwner`) and assigns nobody. A name that was mentioned but was
not a participant is never assigned work by inference.

Content that tried to instruct the assistant is not allowed to originate a commitment at
all: quarantined documents never reach retrieval, and flagged transcript segments are
excluded from the summarizer's grounding while still being reported to the reader.

## Consequences
- The ledger distinguishes kept, renegotiated in advance and silently slipped, and only
  the third is worth escalating — renegotiating early is the behaviour worth encouraging.
- The product is quieter than a naive implementation: unconfirmed promises produce no
  pressure. That is the intended trade.
- Extraction quality becomes a UI problem rather than a correctness problem — a wrong
  proposal costs one keystroke to dismiss instead of an argument about a task nobody
  agreed to.
- The rule is enforced at the data layer (`status = 'confirmed'` in the briefing facts, in
  the planner's grounding, and in the watchers), not by the prompt.
