# ADR 0064 — Work a team can hold

**Status:** accepted · **Date:** 2026-08-21

## Context

Migration 0022 added `team_id` to `tasks`, `projects` and `documents`, indexed all three, and
stated the reason in its own header: every grant the `guest` role holds is team-scoped, so
without a team dimension that role reads nothing at all. It then gave the product a writer for
exactly one of the three columns.

`projects.team_id` has never been written by anything in the product. `documents.team_id` only
by the seed, and by tests reaching past the product with the owner connection — which is what a
missing writer looks like from inside a test suite. So:

- **The guest role reads a quarter of what it is told it can.** Its four grants are
  `task:read:team`, `project:read:team`, `document:read:team` and `note:create:team`. Two of
  those matched no row any product action could produce.
- **The Teams screen counts to zero forever.** It reports tasks, projects and documents scoped
  to each team; two of the three numbers could only ever be `0`.
- **`archiveTeam`'s guard was two-thirds decorative.** It refuses to disband a team "while
  anything is still scoped to it, because the rows would keep a `team_id` pointing at a team
  nobody can see" — a condition that, for projects and documents, could not arise.
- **Retrieval agreed.** `hybridSearch` filters passages by `d.team_id = ANY(actor.teamIds)`, so
  a guest's assistant found nothing either.

And the one column that *did* have a writer had a bad one: `tasks.team_id` rode along in
`updateTask`'s bulk `SET`, with no reason recorded and no check that the team was even in this
organization.

## Decision

**One act, one door, for all three.** `setTeamScope` moves a task, a project or a document
into a team or out of one. Scoping is not an attribute of the work — it is a change to who can
reach it — so it does not belong in an edit form beside the title, and `tasks.team_id` comes out
of `updateTask` to join the other two.

**A reason, and no step-up.** `addTeamMember` asks for a reason and no fresh proof; this is the
same access change from the other side — a person joining work, or work joining people —
and asking more of one than the other only teaches people which door is cheaper. Taking work
*out* narrows, and is asked for a reason anyway, exactly as `removeTeamMember` is: the direction
rule (ADRs 0044, 0046, 0061) is about proof, not about the record.

**The database decides what a team is.** `sw_team_scope_same_org` refuses any write of
`team_id` that does not name a live team in the same organization. A foreign key to `teams` says
the team exists and nothing about which tenant it is in, and work scoped to another tenant's team
would be invisible to every team-scoped reader here, counted in that tenant's team totals, and
perfectly ordinary in the row. `deleted_at IS NULL` is the other half: disbanding is refused
while work is scoped to it, so together the two mean a team and the work in it can never
disagree about which of them exists.

**Two triggers per table, not one.** The check runs when the value arrives — `BEFORE INSERT`,
and `BEFORE UPDATE` only when `team_id` actually changes. A single `BEFORE INSERT OR UPDATE`
trigger would be simpler and wrong: a soft-deleted row does not count towards `archiveTeam`'s
guard, so a team can be disbanded while a deleted row still points at it, and every future edit
of that row — including the one restoring it — would then be refused by a rule about a column
the edit never touched.

**The picker says what the move is worth.** Beside each team: how many people are on it, and how
many of those read at or above this row's classification. A team whose members all read below it
is a scope that grants nothing, and somebody should learn that from the control rather than
later, from nobody mentioning the file.

**Who may do it changed, deliberately.** The old task control was drawn from `listTeams`, which
requires `member:read` — so scoping work to a team was, in practice, an admin-only act that
looked like an ordinary one. It is gated on `<entity>:update` now: a say over the work, not over
the org chart. The team list is only assembled for somebody who passes that gate; where a row
already sits is part of reading it and is answered either way.

## What this deliberately does not do

**It does not refuse a scope nobody on the team can read.** ADR 0063 refuses to hand a thread to
one named person above their clearance, and that is right there: a person is a fixed fact at the
moment of the act. A team roster is not — people join and leave constantly, and a project filed
with a team that grows into its clearance is a normal thing to want. So the count is reported
before the choice instead of the act being refused after it. The test proves the warning was
true rather than decorative: an `internal` project scoped to a team of one guest reports
`0 of 1 cleared`, and the guest still cannot open it afterwards.

**It adds no attribution columns.** `team_set_by`/`team_set_at`/`team_reason` would be the
pattern from ADRs 0044 and 0061, and here it would be a third answer to a question two other
places already answer: the audit log records who, when, why and what it reached; the activity
feed carries it because being given work is news. Inventing the columns for two of the three
tables would also make the three disagree about their own history.

## An instrument that forces honest code

`setTeamScope` writes three literal `UPDATE` statements rather than interpolating a table name
into one. That repetition is not an oversight. An identifier passed through `sql()` is invisible
to the column detector — the blind spot its own header states, and the one that let a §29.5
test appear to defeat a guarantee it never touched (ADR 0060). Written the tidy way, two of the
three columns this change exists to fill would have stayed on the "written by nothing" list
while being written. The detector's cost is a little repetition; the alternative is an
instrument that agrees with you.

## Consequences

- A guest can be given a project and a document to read, for the first time since Phase 0.
- The Teams screen's project and document counts can be non-zero, and the demo now seeds a
  project into the team so the screen shows one.
- `archiveTeam`'s guard fires for all three kinds of thing. The browser check disbands a team
  and is refused; the test suite is refused with **"2 things are still scoped to"**.
- `tests/security/teams.test.ts` stops reaching past the product: the four places it used
  `adminSql()` to put a `team_id` in a row now call `setTeamScope`, because there is finally a
  way to do it. Those raw writes were the clearest evidence the feature did not exist.
- `tasks.team_id`, `projects.team_id` and `documents.team_id` all come off the detector's
  queue: **105 → 103**.
