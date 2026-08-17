# ADR 0045 — A grant nobody could satisfy

**Status:** accepted · **Date:** 2026-08-17

## Context
`ROLE_PERMISSIONS.member` has included `document:create:own` since Phase 0. No member has ever
been able to add a document.

`scopeSatisfied('own', …)` asks whether the resource is the actor's — `ownerId`, `assigneeId` or
`createdBy` matching the actor. `uploadDocument` asked the policy engine about a document that
does not exist yet and passed no owner at all, so `own` could never be satisfied by anybody. The
refusal that came back was `explainMissing`: *"You need Member access to create this document.
An organization admin can grant it in Settings → Members"* — said to a member, about access they
already had, naming a screen where nothing could be changed to fix it.

Two things made it worse than a dead grant:

- **The button was offered to everybody**, viewers and guests included. The refusal arrived
  after somebody had typed a whole document into the form.
- **`document:update:own` was dead too, by consequence.** Nobody could own a document they had
  added, so a member had nothing of their own to correct, reclassify or put a term on. Every
  `own`-scoped grant downstream of creating something inherits the same hole.

The agent runtime had it right all along: `agent_run:create` is asked with
`ownerId: actor.userId`. The convention existed; the document path did not follow it.

## Decision

**A create is asked about the resource that is about to exist.** `uploadDocument` and
`attachTranscript` pass `ownerId: actor.userId`, which is the owner the row is then written
with — the same value, in the check and in the `INSERT`, rather than a check about nothing. That
is what makes `document:create:own` mean the thing the role table has always claimed.

**A document you could not open a moment later is refused, before anything is stored.** A
member reads up to `internal`; the classifier reads compensation as `restricted`. Filing it
would have indexed the content, thrown `PermissionError` on the read-back, and left the member
with an error message and a document they could neither see, check, nor delete. The classifier
is a pure function of the content, so what ingest will decide is knowable before the first
`INSERT`: `uploadDocument` classifies first and refuses with what it read and why. This is the
same rule as ADR 0044 — nobody files a document above their own ceiling — applied where the
classification is first made rather than only where it is changed.

The refusal says what it read (*"Contains compensation information"*), states the ceiling, says
plainly that nothing was stored, and says who can file it instead. A refusal that does not say
what would work is a wall.

**A transcript is not refused the same way.** `attachTranscript` gets the ownership fix and not
the ceiling rule. A transcript is the record of a meeting somebody attended; refusing to keep it
because of a word said in the room would lose the record, and the derived document is a
by-product of that record rather than something a person chose to file. The distinction is
"filing something into the library" versus "keeping what happened".

**The screen asks the same question the server answers.** The knowledge page runs `can(actor,
'document:create', { ownerId: actor.userId })` and passes the decision down. Somebody who cannot
file sees a disabled button and the policy engine's own sentence; somebody who can sees the
ceiling stated in the form, before they type, rather than after.

## What is deliberately not built

**Filing into somebody else's shelf, department or company.** A member's create scope is `own`,
and this change does not widen it. Filing into a knowledge space they cannot read would be a way
to put content somewhere out of their own view, which is the same problem the ceiling rule
refuses one level up.

**The same audit for `knowledge:create:own`.** Members carry that grant too, and `knowledge`
covers spaces — the shelves the library is organised by. Whether an ordinary member should be
able to add a shelf is a decision about how a company wants its structure governed (ADR 0036),
not a defect to quietly fix. It is named here rather than left to be discovered.

## Consequences
- A member's document is theirs, so `document:update:own` starts meaning something: they can
  reclassify it within their own ceiling and set its term, both of which are already audited.
- `POST /api/documents` answers through the one error mapper, so a refusal is 403 and a
  document above the filer's ceiling is 400 with the sentence that says why — the screen
  branches on the class rather than on prose somebody will reword.
- The upload form's fields have ids and labels, which they needed anyway and now have.
- The demo's member (Priya Raman) adds a document in the acceptance loop and in the browser
  check, and both put the demo back through the owner's delete.
