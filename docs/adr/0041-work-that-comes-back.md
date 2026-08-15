# ADR 0041 — Work that comes back

**Status:** accepted · **Date:** 2026-08-15

## Context
`tasks.recurrence_rule` has existed since migration 0002 and nothing has ever written to it or
read it. Every recurring obligation an operations team has — the weekly temperature logs, the
month-end reconciliation, the quarterly audit review — was retyped by a person each time, or
forgotten. The seed's own task list was full of them, sitting there as one-offs.

The column alone could not carry the feature. A recurrence needs a *series*, or occurrence
three has no way to know it is the same recurring thing as occurrence two and "stop repeating
this" has nothing to stop.

## Decision

**The grammar is the one the product already has.** Workflow schedules are cron, evaluated in
a timezone, with the traditional aliases and named refusals — `@reboot` is not a schedule, it
is "whenever the process happens to start". Recurrence reuses that module rather than
inventing a second grammar, so "every weekday at 9" means the same thing on a task as on an
automation, is read back by the same describer, and is refused in the same words.

**One open occurrence at a time.** A rule that materialises a year of rows floods every list it
appears in and makes the overdue count meaningless. The next occurrence is created when the
current one reaches a terminal state, and a partial unique index holds the invariant — so a
double completion, or two people completing at once, cannot produce two. The code checks
first only so that the second completion reads as "already done" rather than as a constraint
violation; the index is the authority.

**Finishing one makes the next, and cancelling counts as finishing.** "Nothing to file this
week" is not "stop filing". Ending the series is a separate act with its own audit line —
clearing the rule — and the occurrences already made stay, because they were real work.

**Rolled forward at completion, not by a sweep.** There is only ever one open occurrence, so a
background sweep would have nothing to find; and the person who just ticked it off is the one
who wants to see the next date.

**Counted from the later of the occurrence's date and now.** A weekly task completed three
weeks late would otherwise produce a next occurrence already two weeks overdue — a product
apologising for its own arithmetic with a brand-new late task.

**The rule moves to the open occurrence.** Leaving it on the finished one would make the series
look like two rules and would let somebody "stop" a repeat by editing a task that is already
done.

**The timezone is the assignee's**, through their department, falling back to the
organization's — the same resolution the working calendar uses (ADR 0039). "Every Monday at
nine" is nine o'clock where the person doing it is, not where the server is or where whoever
is looking at it happens to be (§26.5).

**A due date is a promise, not a delivery.** When the next occurrence lands on a day its owner
does not work, the date is *not* moved — moving it would change what was promised. The screen
says so, and the chasing already respects the calendar, so nobody is nudged about it until the
next working day.

## Consequences
- `set_task_recurrence@v1` joins the tool catalogue: "make this weekly" is among the most
  common things the assistant is asked, and its `preview()` reads the schedule back in English
  before anything is written — a repeat somebody did not mean is a task that comes back for
  ever.
- The list and the task page carry a `repeats` chip, so a recurring task is not read as a
  one-off.
- The demo seeds three genuinely recurring obligations. They were already in the seed as
  hand-typed one-offs, which is exactly the problem this closes.
- A new occurrence is `created_by_actor_type = 'system'` and carries a `supersedes` link back
  to the one it came from, so "why does this exist?" is answerable in one click like every
  other derived entity (§3.4).
- Nothing recurs without a due date, and the CHECK constraint says so rather than leaving a
  rule that could never produce a date.
