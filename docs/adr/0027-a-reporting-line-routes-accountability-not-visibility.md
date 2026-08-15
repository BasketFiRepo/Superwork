# ADR 0027 — A reporting line routes accountability, not visibility

**Status:** accepted · **Date:** 2026-08-15

## Context
`reporting_relationships` was created in migration 0001 and seeded with a real org chart —
eleven lines including one dotted — and read by nothing. Three controls sat on top of it,
all of them hollow:

- The nudge ladder's fifth rung declares `audience: 'manager'`, and every rung was delivered
  to `recipient_user_id` regardless. **The escalation went to the owner**, carrying a message
  written in the third person about them: *"{owner} has an item {days} days overdue that
  others are waiting on."* The `audience` field had never selected a recipient; it only ever
  decided whether a rung was skipped. The fourth rung, `audience: 'waiter'`, had the same
  fault.
- `noSurprisesReviewHours` was defined on every jurisdiction profile, surfaced on the
  transparency screen, quoted in the compliance review's evidence — and enforced nowhere.
- The compliance review counted `stage >= 5` nudges as "escalation(s) recorded", which was
  evidence about something that had never happened.

Building on top of a table like this is the point at which a work product becomes a
surveillance product, so the decision is as much about what is refused as what is built.

## Decision

**A reporting line routes accountability to a person. It is not a window onto anybody.**

It does two things: it decides who an overdue item escalates to *after the person has been
asked themselves*, and it decides who may be asked to decide something they proposed. There
is no view of a report's activity, no rollup of their work, no metric about them — the
§29.5 prohibitions are properties of the product, not of a setting, and the screen where
somebody would look for such a view says so instead of having one.

**Every time the line carries something about a person, that person sees that it did.**
A delivered escalation writes a disclosure to the subject's own record, in the same
transaction as the delivery. *"Nothing reaches your manager that you have not already seen"*
is only a claim until it is evidenced; this is the evidence, and the compliance review now
fails if any escalation exists without one.

**A rung with nobody to address is not sent to the owner as a fallback.** Telling somebody
they are late in the third person is worse than saying nothing, and a fallback here is
exactly how the `audience` field stopped meaning anything. No manager recorded means no
escalation, and the admin screen lists the people that applies to rather than letting the
ladder quietly stop.

**One functional manager, enforced by a partial unique index; dotted lines unconstrained.**
A person with two functional managers has no answer to "who is answerable", and picking one
arbitrarily is how an escalation reaches the wrong person quietly. Dotted lines are context
and are never walked for routing — having several is the point of them.

**A loop is refused by the database.** An org chart with a cycle is one where an escalation
walks forever, and the thing that eventually writes one is a directory sync, not somebody
clicking a button.

**A line is closed, not deleted.** "Who did they report to in March" is a question an audit
asks.

**An approval goes to the person answerable, not to a role at large.** ADR 0026 left this as
a stated gap: a policy naming `manager` meant "anybody senior enough". The chain is now
consulted — but only when the requester cannot decide it themselves, and only to find the
nearest person who actually holds the named role.

## Consequences
- `deliverDueNudges` gained a `subjectId` filter. The acceptance loop needed it: relaxing
  the jurisdiction profile raises the contact budget for *everybody*, so delivering the whole
  queue under a temporarily relaxed profile pushed somebody else's held-back reminders
  through at a limit their organization does not run on. Found by the loop, not by review.
- The demo organization has no legal entity, so it resolves to the strictest profile and
  **escalates nothing**. That is the correct default and it means the escalation path is
  exercised only where a profile permits it.
- Setting a line is not step-up protected. It changes where an escalation goes; it does not
  open a view onto anybody, because there is no such view to open. A reason is required
  instead, because a chart nobody can account for is a chart nobody will correct.
- Reading the chart needs `member:read`, which every role above `guest` holds. The chart is
  names and lines; treating it as sensitive would be theatre while the member directory is
  not.
- The `waiter` rung now resolves the assignee of a task that depends on this one. A task
  nobody is waiting on gets no waiter rung, where previously the owner was told their own
  dependency was late.
- Nothing walks *down* the chain. There is no "my reports' overdue work" query, and adding
  one would be the prohibited feature wearing a different name.
