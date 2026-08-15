# ADR 0039 — A day somebody does not work

**Status:** accepted · **Date:** 2026-08-15

## Context
`departments.holiday_calendar` has existed since migration 0001 and nothing has ever written
to it or read it.

The consequence was not cosmetic. §29 spends its length on how *hard* the system may chase
somebody — a per-person daily budget shared across every agent, a jurisdiction ceiling that
cannot be raised by configuration, an escalation that waits until the person has been told
themselves — and says nothing about *when*, because the column that could have answered it
was inert. So the nudge ladder chased people on Saturdays, on Sundays, and on Christmas Day.
A product that rations its reminders carefully and then delivers one of them on Boxing Day has
not understood what the rationing was for.

The column holds a calendar *name*, so the dates had to come from somewhere.

## Decision

**The dates are computed from the published rules, not fetched.** Easter by the anonymous
Gregorian algorithm; England and Wales bank holidays including the substitute weekdays that
appear when Christmas falls at a weekend; US federal holidays and the weekday each is observed
on. Same reasoning as every other external dependency having a working mock (build rule 3):
the whole product runs with no credentials. A real holiday feed belongs behind a provider
interface, and when one exists this becomes its fallback rather than being replaced by it.

**A calendar is a department fact, and it is inherited.** A department is where somebody sits
(ADR 0036), which makes it the right owner for "which days do these people work" — and it is
where the column already was. It is inherited from the nearest ancestor that sets one, so a
company says "England and Wales" once at the top of its tree instead of on every department.

**Everything works in calendar dates, never in `Date` arithmetic.** A public holiday is a date
in a place, not an instant, and the two differ everywhere but UTC. The department's timezone
decides which date "now" is, falling back to the organization's (§26.5).

**There are two gates, and the second one is the guarantee.** Scheduling moves a rung forward
onto the next working day, so a reminder is not dated for a day nobody will read it. But
delivery is checked again at the moment of sending, against the recipient's calendar as it is
*then* — so a reminder scheduled before the calendar was set, or before anybody had thought
about the holiday, is still not delivered on a day its recipient does not work. It waits, and
`nudges.held_reason` records why. A reminder that silently did not arrive is indistinguishable
from a bug, which is the rule this table already followed for cancellation.

**An unset calendar means the behaviour that was there before.** No department, or no calendar
anywhere above them, and the person is chased exactly as they were. This feature may only ever
*reduce* chasing, so its absence has to mean the old behaviour rather than a new default
nobody chose — the same tighten-only rule as the monitoring policy (ADR 0035).

**The gate is on the recipient, not the subject.** On the escalation rungs those are different
people: the manager being told is the one whose weekend is being protected, and the person the
message is *about* is protected by the review window that already exists.

## A bug this found

The acceptance loops asserted that a reminder is delivered, and then delivered it "now". That
was always date-dependent — running them on a Saturday was asserting a weekday — and nothing
showed it until the product learned what a weekend is. Today is a Saturday, so four beats
across two loops failed the moment the calendar was seeded. They now name the working day they
mean rather than depending on which day CI happens to run.

## Consequences
- `deliverDueNudges` returns `heldByCalendar` alongside `heldByBudget`, and the worker logs
  it: held is not the same as sent, and neither is the same as dropped.
- The demo's departments are set to England and Wales, because Northwind is a British company.
- A person's own reminders page tells them which calendar governs them, which department it
  came from, and the next few days they will not be chased on. The other end of the same fact
  is the department screen, where it can be changed.
- Four calendars ship: `none` (round-the-clock, and chosen deliberately), `weekends`,
  `uk-england-wales`, `us-federal`. A name the product cannot work out is refused rather than
  stored, at the repository and again as a CHECK constraint.
- Deferral is bounded at a fortnight. A calendar that somehow marked every day as a holiday
  would otherwise defer for ever, and at that point the honest answer is to deliver.
