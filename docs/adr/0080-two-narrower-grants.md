# ADR 0080 — Two narrower grants, and the instrument that found them

**Status:** accepted · **Date:** 2026-08-23

## Context

ADR 0079 found `audit:read:org` sitting in the administrator's grant list with nothing behind it,
and discovered on the way that the permission did not even mean what the list implied — a
manager's `*:read:org` had matched it all along. That was found by hand, by asking a question the
column detector cannot express: **which permissions does the ladder grant that nothing checks?**

A question worth asking once is worth an instrument. `scripts/permission-coverage.ts` asks it on
every run, and CI runs it beside the column detector.

## What the instrument does

It reads the ladder for grants that name **both** halves — `task:complete:own` is a claim about a
specific verb, `task:*:department` and `*:read:org` are not — and asks whether any code path checks
each one. It reports both directions, because a check for something no role grants is the mirror
failure: a feature refused for everybody, permanently.

Three sharpenings, all of them learned by it being wrong on its own first runs:

1. **It reads computed actions.** The file's first version asserted in a comment that every
   `can()` call passes a string literal. Running it found fourteen that do not. Had it skipped
   them it would have reported `workflow:simulate` and four others as unchecked with the check
   two lines away in a ternary. It now reads a literal, a ternary of two literals, a template
   with a literal resource, and a bare identifier whose resource is legible from the `type:`
   beside it — and prints what is left.
2. **It reads tool declarations.** `email:draft` came back as unchecked. It is checked, by every
   agent tool declaring `requiredPermissions: ['email:draft:org']`, which the registry and the
   gate both turn into a `can()` call. A declaration that becomes a check is a check.
3. **It does not read comments.** It reported `knowledge_space:read` as checked in `sharing.ts`.
   The only occurrence there is inside a comment *explaining that the bug it describes was
   fixed* — the detector read the note about a defect and recorded it as the defect's absence.
   The column detector learned the same lesson; this stripper is separate because that one blanks
   SQL's `--` to end of line, which in TypeScript would eat everything after a decrement.

Its largest blind spot is stated in the file: **a wildcard can never be reported as unchecked, and
a wildcard is what caused ADR 0079's defect.** What it catches is the loose end that leads to the
knot, not the knot.

## What it found

Five grants named by the ladder and checked by nothing. Two of them were real, and both are the
same shape: **a narrow grant sitting underneath a broader one, where the broader one is what the
code actually asks about.** The narrow grant is never evaluated, so it says whatever the list says
and means nothing.

### Reading what was said on the calls

`note:read:org` starts at member. `listInteractions` took no actor at all — the only read in
`crm.ts` without one — because the page calls `getCompany` first, and that does check.

But it checks `company:read`, which a **viewer** holds. The ladder draws a line between *you may
see that we have this customer* and *you may read what was said on the calls*, and the demo's
viewer is a board observer: exactly the person that line was drawn for. Reading the notes rode in
on the read of the company, and `note:read` had never once been evaluated.

It now takes an actor and checks. The company page still renders for a viewer — the notes panel
says why it cannot show them, and the refusal talks about the notes rather than the company,
because a refusal that named the company would describe a different product from this one.

### Closing somebody else's work

`task:complete:own` has been in the member's grant list since the ladder was built. Completion
arrives as `status = 'completed'` through `updateTask`, which checks `task:update` — and a member
holds `task:update:team`. So a member could mark a teammate's task done: stopping its nudges,
closing the commitment behind it, and changing what the briefing says about somebody else's week.

`updateTask` now checks `task:complete` **on the transition, not on the state**. That distinction
carries weight: re-saving an already-completed task is an edit, and refusing it would make the
finished half of the board read-only to everybody but the assignee. A manager still passes on
`task:*:department`, so this narrows exactly one rung — the rung the ladder always described.

`TaskView` gained `createdBy`, because the policy's `own` scope means owner *or* assignee *or*
creator and a member who raised a task they are not assigned is inside that word. It is
deliberately **not** passed to the `task:update` check beside it: that check has never resolved
`own` through the creator, and starting now would widen who may edit rather than narrow it — the
direction that asks for a reason nobody has given.

### The three that were not work

Named here rather than left on the queue to be rediscovered:

- **`milestone:read:org`** — milestones are read as part of their project, under `project:read`,
  which every rung including viewer holds at org scope. No gap; the grant is decoration.
- **`approval:request`** — approvals are raised by the agent gate when a tool needs one, not by a
  person performing a "request" action. There is no act to check it on.
- **`document:share_external:department`** — there is no external sharing feature. This is
  `audit:read`'s shape exactly, and unlike `audit:read` there is nothing here to connect it to
  without inventing the feature first.

## A latent one, recorded rather than fixed

Both the gate and the registry read `requiredPermissions[0]` and drop the rest. All forty-six tools
declare exactly one today, so there is no live hole — but the field is a plural array whose tail is
silently ignored, and the day somebody adds a second permission it will be unenforced without a
word. The detector reports any tool that declares more than one, so the day it happens is the day
somebody is told.

## Consequences

- The permission queue goes **5 → 3**, and the three that remain are judged, not pending.
- A board observer can no longer read internal call notes.
- Closing work and editing work are different acts, as the ladder always said they were.
- The lens that found ADR 0079 by hand now runs on every build.

## Lesson

ADR 0079's lesson was that a permission which is never checked is never wrong. This is the shape
that keeps it unchecked: **a narrower grant underneath a broader one that answers first.** Nobody
writes a check for the specific thing, because the general check is already there and already
passes. The list keeps saying the narrow sentence, and the product keeps enforcing the wide one,
and the two never meet because no test can fail.

You cannot find that by reading the ladder. It reads correctly — that is the entire problem.
