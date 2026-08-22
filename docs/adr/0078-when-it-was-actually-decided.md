# ADR 0078 — When it was actually decided

**Status:** accepted · **Date:** 2026-08-22

## Context

`decisions.decided_at` is `NOT NULL DEFAULT now()` and nothing in the product has ever set it.

It is not decorative. It is the `ORDER BY` of the decision log, and it is **both** of the table's
indexes — `decisions_org_idx` and `decisions_project_idx` are keyed on it. So the order the log is
read in was the order the summarizer happened to run, and the column that says when something was
decided said when a row was written.

The detector's own report names this exact case. Its *stamped by the database* section says to
read a clock default as work **only if the moment it names could ever be a different one**. Here
it plainly could: `recordDecision` is called from one place, the meeting summarizer, and a meeting
summarised a week after it happened produced decisions dated today. They sorted above decisions
made yesterday, in the artifact §12.5 calls the most valuable and most neglected in project work.

## Decision

**The moment was already in the data, and had been since migration 0010.** A decision carries the
transcript segment it was read out of; a segment carries `starts_at_seconds`, its offset into the
recording; the meeting carries `starts_at`. Nobody had written the addition.

`whenItWasSaid` answers in order of how much it knows:

1. **the line it was said on** — the meeting's start plus the segment's offset;
2. **the meeting it was said in**, for a decision recorded against a meeting with nothing to cite;
3. **now**, for a decision that came out of no meeting at all — which is then the truth rather
   than a default standing in for one.

**The log shows the column it has always been ordered by.** A date on the decision log; on the
meeting panel, where everything shares a day, the minute — because "said at 09:34" locates a
decision in a conversation somebody remembers.

**Two rules the database keeps**, because the derivation is arithmetic and arithmetic can be
wrong in ways a reviewer will not catch:

- A decision cannot have been made **in the future**, or **before the meeting it came out of**. A
  decision landing before its own meeting is a sum that has gone wrong — an offset applied to the
  wrong transcript — rather than a date somebody typed.
- A decision can only **cite a line from the meeting it is filed against**. The anchor is what the
  date is computed from, so an anchor into another meeting's transcript is a wrong date waiting to
  be written, and separately a citation that sends a reader to the wrong room.

Triggers rather than CHECKs, for the reason `logInteraction` already states about the same rule: a
constraint cannot call `now()`, and a row that was legitimate when written must not become invalid
as the clock passes it. Both are split across insert and update so that confirming a decision
months later is not refused over a date the confirmation never touched.

## What the seed was saying

The seed dated every decision at its meeting's **end** and anchored it to the meeting's **first
segment** — so all four demo decisions cited somebody saying "Right, incidents first. Anything
open from last week?", and the citation the whole decision log rests on pointed at hello.

`SeedMeeting.decision` now carries the `excerpt` its commitments already carried, and both the
anchor and the date come from it. The four decisions now read 09:31, 09:32, 09:34 and 09:34 — each
the minute of the line it was read out of. The new same-meeting trigger would have refused the old
arrangement only if the anchor had been from another meeting, which it was not; what caught this
was writing the migration and looking at what the seed actually did.

## Consequences

- The decision log reads in the order things were decided.
- Every decision cites the sentence it came from, so "why does the log say that?" opens on the
  right line of the right transcript.
- `decisions.decided_at` comes off the detector's queue: **76 → 75**.
