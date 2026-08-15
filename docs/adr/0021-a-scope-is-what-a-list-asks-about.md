# ADR 0021 — A scope is what a list asks about

**Status:** accepted · **Date:** 2026-08-15

## Context
`teams` and `team_members` were created in migration 0001 and nothing has ever written to
either. That looked like two unused tables. It was not: the `team` scope in the policy
engine had never once evaluated true, and the role that pays for it is `guest`, whose entire
permission set is

```
task:read:team  project:read:team  document:read:team  note:create:team
agent_run:create:own  agent_run:read:own
```

A guest could therefore read nothing at all, and the denial said *"You need Member access to
read this task"* — which reads like a considered policy rather than a dimension that was
never built.

The scope was dead in **four** independent ways, and each had to be fixed for any of the
others to matter:

1. No team existed.
2. No resource table carried a `team_id`, so nothing was team-scoped.
3. Nothing ever passed `resource.teamIds` to `can()`, so `scopeSatisfied('team', …)`
   evaluated `[].some(…)` and returned false even given (1) and (2).
4. Every list gated on an **organization-level** resource — "may you read every task" — which
   is false for any role whose grant is narrower, so the query never ran at all.

The fourth is the interesting one, and it was invisible: it is not a bug in the team scope,
it is a bug in how a list asks the policy engine a question.

## Decision

**A list asks which rows it may consider, not whether it may read everything.**
`grantedScope(actor, action)` returns the broadest scope the actor holds for an action,
independent of any particular resource, and the list turns that into a SQL predicate —
`org` adds nothing, `department` filters by department, `team` by `team_id`, `own` by
assignee or owner. `can()` still answers the per-row question wherever there is a row.

This is the difference between a permission model that is checked and one that is
*enforced*: a gate taken at organization level silently reduces every narrower role to
nothing, and does it without ever failing.

**Relation tuples are unioned in, not intersected.** A tuple grants one specific row
regardless of scope, so `sharedObjectIds(actor, type)` adds `OR id = ANY(...)` rather than
narrowing. A guest with one shared document sees their team's documents *and* that one.

**Clearance applies only to resources that carry a classification.** `checkClearance`
defaulted an absent `sensitivity` to `internal`, which put every unclassified resource above
the guest ceiling of `public`. Tasks, projects and notes have no classification column at
all, so the check was denying on a property the resource does not have — and saying so, in a
message about data classification. It now returns early when `sensitivity` is undefined.

The blast radius is exactly the guest role: every other role's ceiling is `internal` or
higher, so the old default was already satisfied for them, and the 376-test policy pack
passed unchanged. Anything that *does* carry a classification is still checked, and
`documentAudience` — which had been relying on the default — now passes the document's real
sensitivity.

**A team is not a department.** A department is where somebody sits and there is one per
person; a team is what somebody is working on, there can be several, and people join and
leave constantly. Both scopes already existed in the engine for that reason. `team_id` is
nullable on tasks, projects and documents, because most work belongs to a department and a
person and forcing a team onto it would be inventing structure to satisfy a schema.

**Membership is a grant of access, and is treated as one.** It takes a reason, it is
audited, and it takes effect on the member's next request because `loadActor` reads team
membership fresh every time. There is no cache to invalidate and no delay to explain.

**A team cannot be disbanded out from under its work.** Archiving is refused while any task,
project or document is still scoped to it, and the refusal counts them. Otherwise those rows
keep a `team_id` pointing at a team nobody can see, and everybody whose route to that work
was the team loses it with no visible cause.

**Search obeys the same scope as the detail view.** `hybridSearch` applies
`team_id = ANY(actor.teamIds)` when the actor's document grant is team-scoped. Without it,
retrieval and `getDocument` would tell different stories about the same document — the exact
split-brain ADR 0019 was written about.

## Consequences
- `guest` is now a working role: a contractor on one team sees that team's work and nothing
  else, and loses it when they leave. That behaviour is asserted in the test pack and driven
  by the Phase 5 loop.
- `grantedScope` is a second way to ask the policy engine a question, which is a real cost —
  two functions that must stay consistent. The mitigation is that it shares the grant
  parsing and scope ranking with `can()` rather than reimplementing them, and that it is
  deliberately resource-independent: it cannot answer a per-row question, so it cannot be
  misused as a substitute for one.
- Only `listTasks` and `listDocuments` are scope-aware. Other list endpoints still gate at
  organization level, which is correct for every role above `guest` and wrong in the same
  way for `guest` — named in the README rather than left to be rediscovered.
- Nothing infers a team. The agent will not scope work it creates to a team, and the
  workflow compiler has no notion of one.
- Writing the browser check surfaced a trap worth recording: the assertion waited for text
  that also appears in the component's own explanatory copy, so it resolved instantly
  against static text and passed without the request having happened. It passed for the
  wrong reason, and the only symptom was an unexplained 400 in the console-error check.
