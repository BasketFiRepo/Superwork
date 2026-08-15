# ADR 0032 — Being on a project lends a read, not a say

**Status:** accepted · **Date:** 2026-08-15

## Context
`project_members` was created in migration 0002. Exactly one thing writes to it — the seed,
which puts the owner on every project — and nothing reads it. So being on a project was a
row in a table and nothing else: it granted nothing, appeared on no screen, and could not be
changed. Meanwhile the project page answered *"who is doing this?"* with one chip naming the
owner and a panel listing who it had been **shared** with.

Those are different questions. A share is what you give somebody outside the work; a roster
is the work's own answer to who is doing it. The product could express the first and not the
second, which is why the only way to give a contractor access to a project they were
actually working on was to *share* it with them — recording, permanently, that they were an
outsider being shown something.

And who owns a project was stated twice: `projects.owner_id`, which every read uses — the
list, the page, the `own` scope in the policy engine — and a roster row with role `owner`
beside it, written independently by the seed and reconciled by nobody. Nothing would have
noticed them diverging, because nothing read the second one.

## Decision

**A roster lends a read of the project and of the work inside it, and nothing else.** Same
rule as a container share (ADR 0024) and for the same reason: the set of tasks in a project
changes daily, so whoever puts somebody on it cannot see what they are handing over. Write
access is granted on the row where it can be seen.

**It is not a share, and the product never says it is.** Roster membership is loaded onto
the actor as `projectIds` rather than folded into the relation tuples, so the refusal, the
allow-reason and the personal record can all say which of the two it was: *"Allowed because
you are on this project"*, not *"shared with you"*. Two mechanisms that grant the same thing
should still be distinguishable when somebody asks why they can see something.

**The clearance ceiling still applies.** Being put on a confidential project does not make
somebody cleared to read one — the project stays shut and its tasks stay shut with it. The
container branch checks the ceiling itself, because a task carries no classification of its
own and would otherwise open through a project its reader cannot open.

**Who owns a project is a property of the project.** `projects.owner_id` is the fact; the
roster's owner row is derived from it by a trigger. Handing a project over moves the owner
row with it and **demotes the previous owner to contributor rather than removing them** —
they were working on it before it changed hands and still are. The roster API refuses to set
or remove the `owner` role and says where that decision actually lives. Same shape as the
jurisdiction history (ADR 0028) and the plan tier (ADR 0030): when two places must agree,
the agreement is not something application code should be trusted to remember.

**Staffing a project needs `project:update`, not `member:update`.** This is the work, not
org structure: a manager who runs a project can staff it without being able to edit the
company's teams. Reading the roster needs only a read of the project — a contractor on it
should see who else is on it, and the roster is not the staff directory that `member:read`
guards.

**It appears on the person's own record.** "Projects you are on", with the reason somebody
gave, next to the share list. Access that a person's own record does not mention is access
nobody can audit, and the share list alone would have answered *"why can I see that?"*
incompletely.

## Consequences
- `loadActor` runs one more query per request, capped at 1000 rows for the same reason the
  tuple load is capped: an actor on thousands of projects is a modelling problem, and
  silently paying for it on every request hides that.
- The seed no longer writes the owner's roster row — the trigger does — and instead puts
  everybody who has work assigned on the project they are working on, so the demo has a
  roster that matches its own task list.
- Roles are `owner`, `lead`, `contributor`, `reviewer`, and only the last three can be
  assigned. `role` was free text with no constraint, so `Contributor`, `contrib` and
  `lead ` were three different roles.
- A roster row is soft-deleted when somebody comes off, and the read goes with it on their
  next request. Nothing is back-filled into shares: coming off a project you were also
  *shared* leaves the share, because those were two separate decisions by two people.
- The roster does not yet route anything — nudges, insights and briefings still address the
  assignee and the owner. Being on a project says who is doing the work; using that to
  decide who gets told about it is a separate decision, and it is not made here.
