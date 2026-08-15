# ADR 0037 — A saved view is a question, and a watch is not a grant

**Status:** accepted · **Date:** 2026-08-15

## Context
`saved_views` and `task_watchers` were created in migration 0002. Neither has ever been read
or written by anything, the seed included — they were the last two of the six tables the
dead-table detector found, and the only two worth building rather than dropping.

Their absence was not neutral. The tasks list offered five fixed filters and a search box, so
every person retyped their own question into it every day; the inbox offered five views and
remembered none of them. And the only person a task ever told anything to was its assignee —
so the manager who asked for the work, the colleague waiting on it and the person who raised
it all had to go and look. A product where following somebody else's work means remembering
to check is a product where nobody follows anything.

Both tables also had a way of being unsafe that is specific to them. `saved_views.query` is a
`jsonb` blob that a list screen would have to trust. `task_watchers` names a person the
product will then write to, and it carries no foreign key to the organization on either end.

## Decision

**The query is whitelisted on read, not only on write.** Only the keys the two lists actually
accept survive — `filter` and `q` for tasks, `view` for the inbox — and the whitelist runs
every time a row is read, not only when one is saved. A view is a button somebody presses
weeks later, and the row can be changed by a migration, a restore or a support script in the
meantime; the moment that matters is the moment it is read. The API schema refuses the same
set politely, which is the courtesy; the repository is the guarantee.

**A saved view is a question, not a share.** Applying one runs the same scope-aware read as
the screen it belongs to, so a shared view shows each person exactly what they could already
see. Two people opening the same view can see different rows, and that is right — it is the
only way a shared view can be safe. A view also belongs to whoever made it: a colleague can
open a shared one and cannot delete it.

**A watch grants nothing.** You may only follow what you can already read, and the watch never
widens it. The `watching` filter on the list is a narrowing applied on top of the usual
visibility clause, never instead of it.

**The fan-out re-checks at delivery.** This is the decision the rest of it rests on. Access is
not frozen at the moment somebody pressed Follow: a task can move to a project they were taken
off, its classification can rise, their role can narrow, they can leave. Every notification is
written only after `can()` says that person could open the task *now*, so a watch that
outlives the access it was made under goes quiet rather than leaking. The alternative — trust
the row, deliver the title — would have made `task_watchers` a stored permission that nothing
ever revoked.

**Both ends of a watch belong to one organization**, enforced by a trigger rather than by the
callers, because a row pointing at another tenant's person would send them a sentence about a
task they cannot see. Same reasoning as the jurisdiction history (ADR 0028) and the department
tree (ADR 0036): when two facts must agree, the agreement is the database's.

**Only your own watch.** There is no user id in the watch API. Adding a colleague would be a
way of deciding what they are told without asking, and of learning what they are told — which
is the shape §29.5 prohibits. Unfollowing, by contrast, is allowed even when the task has
since become unreadable: the one thing a person can do about a message they should not be
getting must not be the one thing the product refuses.

**Four changes are worth interrupting somebody for** — status, assignee, due date and title.
A description tidy-up is not. A subscription that fires on every edit is one people turn off,
and then the ones that matter go unread too.

## Consequences
- `task_changed` joins the notification types, and lands on `/reminders` with everything else
  addressed to a person; the header badge counts it. No new surface was needed.
- Erasure now names both tables in its inventory and deletes them: a shared saved view is
  still its maker's, so it goes with them.
- The demo arrives with one private view, one a colleague shared, an inbox view and two
  tasks Maya follows. Both surfaces are invisible when empty and neither is the sort of
  thing somebody tries first.
- `saved_views.user_id` was nullable. A view with no owner could not be edited or removed by
  anybody, which is how a list ends up with a filter nobody can get rid of; it is now
  `NOT NULL` by CHECK, with one name per person per list.

## A bug this found

The phase-5 loop was not repeatable. Its follow-up beat turns the demo's one outbound thread
inbound — to prove a follow-up closes itself when the customer writes back — and never put it
back, so the *second* run of the loop on the same database found no thread to chase and died
on an undefined read. It had been failing that way since the follow-ups increment; running the
loop twice is what surfaced it. The beat now restores the thread's direction and timestamp,
and asks for the thread with a message that says what went wrong rather than a `!`.
