# ADR 0048 — The work a milestone is made of

**Status:** accepted · **Date:** 2026-08-17

## Context
`tasks.milestone_id` has existed since migration 0002. Nothing has ever written it.

Milestones themselves became real in ADR 0036: a project can add one, reschedule it, reach it
or drop it, and the health score reads their dates. But each was **a date with a name on it and
nothing underneath**. "What is this milestone waiting on" had no answer at all, and "are we
going to make it" had none beyond somebody looking at the calendar and guessing. The column
that answers both was even carried through the recurring-task copy (ADR 0041) — so every
occurrence of a repeating task faithfully copied a null.

## Decision

**Filing work against a milestone goes through `updateTask`.** Not a control of its own: a
milestone is a field of the task, and routing it through the one writer means it passes the same
permission check, the same optimistic-version check, the same activity line and the same audit
record as every other change to that task. The screen gets its own panel; the write does not get
its own path.

**A task's milestone belongs to the task's own project, and the database says so.** A milestone
is a promise one *project* makes; work filed against another project's milestone is a sentence
no screen could render honestly. A trigger refuses it whatever writes the row, and a CHECK
refuses a milestone on a task belonging to no project.

A composite foreign key — `(project_id, milestone_id) REFERENCES milestones (project_id, id)` —
was the obvious alternative and is worse: its `ON DELETE SET NULL` would null *both* columns, so
hard-deleting a milestone would quietly unfile every one of its tasks from the project too. The
existing single-column reference already does the right thing on its own; the trigger adds only
the cross-row rule that a reference cannot express.

**A milestone cannot be called reached while work on it is still open.** Otherwise "done" means
"somebody pressed the button", and the date it records stops being evidence of anything. The
refusal names the count and the first task, and states the three ways out: finish the work,
cancel it, or take it off the milestone. This is the same shape as refusing to disband a team
that still has work scoped to it (ADR 0036).

**Cancelling is still allowed with work on it**, because abandoning a milestone with unfinished
work is exactly what abandoning one looks like. The distinction matters: `done` is a claim about
the work, `cancelled` is a decision about the milestone.

**New work cannot be filed against a milestone that is already reached or cancelled.** A closed
milestone said something true about the work that was on it when it closed; adding to it
afterwards edits that statement retroactively.

**And a repeating task carries its milestone forward only while the milestone is open.** The
reachable case is a cancelled milestone — allowed with open work — whose live occurrence is then
finished. Without the guard, the next occurrence would appear as fresh open work on a milestone
somebody has already closed, which is the same retroactive edit one step removed.

**The counts are SQL's.** `taskCount`, `openCount`, `overdueCount` and `dueAfterCount` are one
lateral join in the query that already reads the milestones — not a second query assembled in
TypeScript, which is how two screens come to disagree about a number (§9.1). `dueAfterCount` is
the interesting one: open work due *after* the milestone it belongs to is the milestone saying
it will slip, in advance and without anybody scoring it.

## What is deliberately not built

**Filing a milestone at creation.** `createTask` does not take one, so the agent's `create_task`
tool cannot file work against a date on its own. Attaching afterwards is a person's judgement
about what a promise is made of, and the tool catalogue is not where that judgement belongs
until somebody asks for it.

**A milestone rolling its own date up from its work.** The dates stay independent: a milestone
that silently moved when a task slipped would be a promise that cannot be missed, which is the
opposite of what it is for. The product states the disagreement (`dueAfterCount`) and leaves the
decision to a person.

**Projects themselves are still seed-written.** Nothing in the product creates a project —
`project:create` is granted to nobody in practice and no repository function exists. Found while
building this, named here rather than folded in.

## Consequences
- `MilestoneView` gains four counts; the project page shows "3 of 7 done", what is late, and
  what lands after the date.
- `TaskView` gains the milestone, its date and its status, so the task page can state that this
  work is due after the milestone it is part of.
- The task page's panel offers only the project's own open milestones, plus whichever one the
  task is already on, so a closed milestone stays visible on the work that was on it.
- `describeChange` mentions filing and unfiling, so the activity feed carries it; the watcher
  rule is unchanged, because a filing change is not one of the four things worth interrupting
  somebody for (ADR 0037).
