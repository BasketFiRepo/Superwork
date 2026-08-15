# ADR 0020 — A dependency that can be walked past is a comment

**Status:** accepted · **Date:** 2026-08-15

## Context
`task_dependencies` was created in migration 0002 and nothing has ever written to it. The
daily briefing reads it: the "your work is blocking other people" section runs an `EXISTS`
against this table every time a briefing is generated. That section has therefore been
structurally empty since Phase 2 — for every user, on every day, without ever failing or
warning.

Two things were missing before it could be used, and one of them was invisible.

The **index** was wrong for the only read anybody does. The table had a unique index on
`(task_id, depends_on_task_id)`, which serves "what does this task wait for". Every read in
the product goes the other way — "what is waiting for this task" — and nothing indexed
`depends_on_task_id`. The briefing's subquery was a sequential scan whose emptiness was the
only reason nobody noticed.

The **cycle check** did not exist at all. A dependency graph with a cycle is a set of tasks
none of which can ever be completed, each correctly reporting that it is waiting for another.

## Decision

**A cycle is refused by the database, not by the repository.** A `BEFORE INSERT OR UPDATE`
trigger walks the graph from the proposed prerequisite and raises if it reaches the dependent
task. The repository catches that and rewrites it into a message naming the two tasks a
person is looking at, but the repository is not the control — the thing that eventually
writes a cycle is a bulk import, a migration or an agent, not somebody clicking a button
twice. This is the same reasoning as the append-only trigger on `audit_logs`: a rule the
application asks for politely is not a rule.

The recursion is bounded by the unique index, since an edge cannot repeat and a finite graph
gives a finite walk. The depth cap of 100 is a second belt for whoever removes that index in
a later migration without thinking about this one.

**Both ends must belong to the same organization, and a trigger enforces that too.** RLS stops
one tenant *reading* another's rows, but nothing stopped a row *referencing* across the
boundary: the foreign keys point at `tasks(id)` with no tenant in them. A dependency spanning
two organizations would be invisible to both and would block a task forever from a tenant
that cannot even see the reason.

**Completing a task past an unfinished prerequisite is refused, and names it.** This is what
makes the record a dependency rather than a note. The refusal names the first thing being
waited on and its assignee, and points at removing the dependency as the alternative — because
sometimes the dependency is what is wrong.

**A cancelled prerequisite counts as finished.** Cancelled work is not going to happen, and
treating it as an unmet prerequisite would leave the dependent task permanently uncompletable
with no obvious cause.

**Finishing a task tells the people it was holding up — and only those whose *last*
prerequisite it was.** A task waiting on three things is not unblocked when one of them
finishes, and telling somebody it was would train them to ignore the message. Nobody is told
about their own completion. This is the other half of the briefing's "you are blocking three
people": without it, the only person who learns the blockage cleared is the one who cleared
it.

**Permission is checked on the dependent task, not the prerequisite.** Saying "my task waits
for yours" is a statement about my work. Requiring the other person's permission would mean
nobody ever records a dependency across a team boundary, which is where all the interesting
ones are. It cannot be used to interfere with anybody else's task: the constraint falls
entirely on the task the actor already controls.

**The counts are on the list view.** `blockedByCount` and `blockingCount` are two scalar
subqueries in the task select, so the list can show "waiting on 2" and "blocking 3" without a
second round trip. Measured after adding them, the scoped list view is 2.0 ms p95 against a
400 ms budget — the new index on `(organization_id, depends_on_task_id)` is what makes the
second one cheap.

## Consequences
- The notification links to `/tasks/{id}`, which did not exist. A task detail page was
  therefore part of this change rather than optional — a notification pointing at a 404 would
  have been worse than no notification.
- A dependency has no type. There is no "starts after" versus "finishes before"; there is one
  relation, "cannot be completed until". Richer scheduling semantics would need a column and
  a great deal more interface, and the single relation is what the briefing and the completion
  check both need.
- Nothing automatically sets a task's status to `blocked`. Status is what a person says about
  their work; being blocked is derived from the graph and shown beside it. Overwriting
  somebody's chosen status from a background rule would fight them.
- The agent can record dependencies through the ordinary repository, but nothing in the
  planner proposes them yet. That is a deliberate stopping point: a model inferring "this
  probably waits for that" and having it enforced at completion time is a much larger claim
  than this change makes.
- Writing the loop test surfaced a trap worth recording. Swallowing a database error *inside*
  a `withTenant` callback leaves the transaction aborted, so the commit raises the original
  error anyway; the rejection has to escape the callback for the rollback to happen. The
  acceptance loop now catches outside `withTenant`, with a comment saying why.
