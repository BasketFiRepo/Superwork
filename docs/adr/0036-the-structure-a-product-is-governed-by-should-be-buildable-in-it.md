# ADR 0036 — The structure a product is governed by should be buildable in it

**Status:** accepted · **Date:** 2026-08-15

## Context
Three tables were read all over the product and written by the seed alone.

**`departments`** is one of the four permission scopes. It routes the run queue's fair share,
it scopes agent grants, every person has one, and every project and task can carry one. A
real organization could be governed by the tree and never make a department — including one
syncing its directory, because `applyDirectorySync` assigns people to departments and cannot
create the department it is assigning them to.

**`milestones`** are on every project page and weigh a quarter of the health score. A project
could show them and never gain one.

**`knowledge_spaces`** are listed, shared, filed into and cited. ADR 0025 named this and left
it: *"Spaces are read, shared and filed into; they are not yet authored."* The only shelf any
organization had was the one the seed made, so "file this under…" offered exactly one answer.

The department tree also carries two derived columns, `path` and `depth`, written by hand by
the seed and kept true by nothing.

## Decision

**The tree's shape is the database's.** `path` and `depth` are derived from the parent by a
trigger, and a rename or a move rewrites every descendant — a path that is stale one level
down is worse than no path at all. A second trigger refuses a parent in another organization
and refuses a move that would put a department underneath itself. Same reasoning as the
jurisdiction history (ADR 0028) and the project owner (ADR 0032).

The cascade fires on **any** update rather than `AFTER UPDATE OF path, depth`: that clause
names the columns the *statement* touched, and `path` is set by the BEFORE trigger, so the
narrower form would never have reached the rows underneath. It was written the narrow way
first and the test caught it.

**Archiving refuses while anything is still inside**, and says what — people,
sub-departments, tasks, projects. The rows would otherwise keep a `department_id` pointing at
something no screen shows, and the `department` permission scope would resolve against a
department that is not there. Same rule as disbanding a team, and now as archiving a shelf.

**A milestone is a promise the project makes**, so changing one needs a say over the project
rather than a read of it — the health score reads their dates. `completed_at` moves with the
status and the database refuses a `done` row without one, so "when did we hit that" is
answerable afterwards rather than reconstructed from an audit trail.

**A shelf's default classification cannot exceed what its creator may read**, and a
department-scoped shelf is a departmental act: the department travels into the permission
check, so a manager can make a shelf for their own people while a company-wide shelf needs a
company-wide grant.

## A bug this found

`projectMilestones` and the health score compared `due_on` against
`startOfDay(now, timezone)::date`. That is the *instant* the organization's day began, and
casting it to `date` in a UTC session lands on the **previous** day anywhere ahead of UTC —
so a milestone due yesterday read as not yet late, everywhere in Europe. §26.5 says never
compute "today" in server local time; the intent was right and the cast was wrong. There is
now a `calendarDate(timezone)` helper returning `YYYY-MM-DD`, and both reads use it.

## Consequences
- Creating a department needs `member:update`, the same gate as teams and membership: it is
  org structure, not work. Creating a space needs `knowledge:create` (department-scoped where
  a department is named); milestones need `project:update`.
- The seeded department paths are rewritten by the migration through the same trigger that
  will maintain them, so the invariant holds from the moment it is declared.
- Directory sync still cannot create a department it is assigning somebody to. It can now be
  done on the screen beforehand, which is a smaller gap than the one this closes and is named
  here rather than left to be discovered.
- A cancelled milestone and a removed one are both offered and they are different: the first
  stays on the record as something the project decided not to do, the second was never real.
  The score counts neither.
