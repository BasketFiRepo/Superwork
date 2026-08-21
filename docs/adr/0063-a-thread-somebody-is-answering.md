# ADR 0063 — A thread somebody is answering

**Status:** accepted · **Date:** 2026-08-20

## Context

`conversations.assigned_to` has existed since migration 0010. Nothing has ever written it. Three
things read it:

- **The inbox's "My work" view.** `WHERE conv.owner_id = $me OR conv.assigned_to = $me` — a filter
  the product offers on its busiest screen, half of which could never match anything. The other
  half, `owner_id`, is written by the seed and by nothing else, so "My work" showed whatever the
  seed decided and nothing a person had ever done.
- **The personal record.** The transparency report counts "conversations about you" as
  `owner_id = you OR assigned_to = you` — a number that was short by every thread anybody had
  meant to hand over.
- **`scopeSatisfied('own')`**, which accepts an `assigneeId`. An assignment is the thing that
  would let somebody act on a thread they do not own — except that no assignment could be made.

A column, a filter and a policy branch, with no way to put a value in.

## Decision

**`assignConversation` hands a thread over, and `null` takes it back.** The person must be a
member of this organization, and `sw_conversation_assignee_same_org` makes that true of every
writer as well: a foreign key to `users` says the person exists and nothing at all about which
organization they are in, and a thread assigned across tenants would sit in a "My work" view
nobody can open, looking perfectly ordinary in the row.

**Attribution without a reason.** `assigned_by` and `assigned_at` are recorded and required by a
CHECK; a *reason* is not. An assignment is routine — the most common act on an inbox — and a
sentence per hand-over is friction on the wrong control. But "why is this mine?" is a real
question, so who did it and when are on the record, and the activity feed carries it, because
being given work is news to the person given it. Contrast ADR 0061, one screen away: there the
classification *is* the decision, and the reason is the whole point of it.

**A thread classified above the person is refused, and the refusal names the classification.**
This is where it meets ADR 0061. A confidential thread handed to a member would land in a queue
where the list filter makes it invisible: assigned, and gone. The wording follows the precedent
`document-audience.ts` already set — the person is not the problem, so the message points at the
thing that would have to change if this was really meant.

**The picker only offers people whose clearance reaches the thread**, and the repository refuses
anyway. A list is a convenience and never a control.

**The resource carries the assignee now.** `getConversation` passes `assigneeId` into `can()`,
which it never did because nothing could make an assignment for it to read.

## What that last one is and is not worth

Worth stating precisely, because the obvious claim is wrong. **No role reads conversations at
`own` scope** — viewer, member, manager and admin all hold `conversation:read:org` or wider — so
passing the assignee changes no answer that a *role* decides. Saying "being assigned a thread lets
you act on it" would have been the kind of sentence this repository writes ADRs about.

What it does do is stop the resource lying about the row, and it is exactly what an **exception
granted to one person** reads (ADR 0055). That is provable, so the test proves it rather than a
comment asserting it: a member given `conversation:update:own` still cannot hand the thread on —
until they are assigned it, at which point the same call goes through. Removing the `assigneeId`
from the `can()` call fails that test and nothing else.

## What this does not do

`conversations.project_id` is also unwritten, and it is *not* read: the column detector reports it
as read because it matches column names on other tables, which is a blind spot its own header
states. It stays on the queue as a question, not as half of this change.

`owner_id` stays as it is. Ownership of a thread and who is answering it are different questions —
the first is the relationship, the second is today — and collapsing them to make "My work" work
would have been the easy version of this rather than the true one.

## Consequences

- The "My work" view filters on something a person can set, for the first time.
- The personal record's count of conversations held about somebody is no longer short.
- The trigger, the CHECK and the clearance refusal each have a test that fails without them; the
  browser check hands a thread to Priya as Maya, finds it on Priya's **My work** list signed in as
  her, and takes it back to put the demo back.
- `conversations.assigned_to` comes off the detector's queue. The headline stays at 105 because
  `schema_migrations.applied_at` moved into it from the stamped section in the same change — the
  schema-state test from ADR 0062 now writes that column, and the clock-default rule deliberately
  only fires when nothing else does. The instrument behaving as designed, not a coincidence.
