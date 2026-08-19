# ADR 0051 — Days this office is closed

**Status:** accepted · **Date:** 2026-08-19

## Context
ADR 0039 gave a department a working calendar and the nudge ladder started obeying it: nobody
is chased on a Saturday or on Christmas Day any more. What it gave was a choice between four
names — `none`, `weekends`, `uk-england-wales`, `us-federal` — whose dates are computed from
published national rules. **A department cannot say a single day of its own.**

That gap is not exotic. It is the week between Christmas and New Year that most of the country
takes and no statute names. It is the Monday the depot moves. It is every public holiday of
every country that is not England, Wales, or the United States, which is to say most of them:
a French department can pick `weekends` and is then chased through the fourteenth of July.

The detector that finds this work looks for columns live code reads and nothing writes.
`departments.holiday_calendar` is not one of them — it has been settable since ADR 0039, and
an earlier list of remaining work said otherwise, wrongly, because the write is a conditional
SQL fragment inside a `SET` clause rather than a plain parameter. The real gap here was one
level up: not a column nothing writes, but a set of choices with no way to add to it.

## Decision

**A closure is a date a department names, and it only ever adds a day nobody works.** There is
deliberately no way to express "we do work that bank holiday". The promise this whole area
makes is that it may only ever *quieten* the product — that is what makes it safe for its
absence to mean the old behaviour — and a row that could switch a rest day back on would take
that promise away. A closure declared on a Saturday changes nothing, and `restReason` still
says "a Saturday", because the day was already not worked and the closure did not make it so.

**They accumulate down the tree; the calendar above them overrides.** This is the opposite of
the calendar and right for both. One calendar governs a person, so the nearest ancestor that
sets one wins. Closures are a set: a company shutdown and a depot's own closed day are both
true at once, so a person is governed by every closure on their department and on every
department above it. Nothing travels upwards.

**Threaded through the same loops, not a second implementation.** `nonWorkingReason`,
`isWorkingDay`, `nextWorkingDay` and `upcomingNonWorkingDays` each take the closed days as an
optional argument, so scheduling, the delivery gate, recurrence, and the screen that tells
somebody when they will not be chased all get the answer from one place. The alternative — a
second "is this day closed" check beside each existing call — is the shape that ends with two
places disagreeing (ADRs 0028, 0040, 0047).

**Counted outside the calendar's own branch.** A department with no calendar at all can still
declare a day it is shut. Folding closures inside the `if (calendar)` would have made this
useless to exactly the organizations that need it most: the ones none of the four calendars
covers.

**Reopening keeps the row.** Taking a closure away is the widening direction — people are
chased on a day the company had said it was shut — so the row stays, with `reopened_by`,
`reopened_at`, and a reason of at least four characters, enforced by a CHECK that will not let
one exist without the others. It does **not** ask for a fresh proof of identity the way raising
a limit does (ADRs 0044, 0046, 0050): what it restores is the product's ordinary behaviour
rather than a new reach, it is visible on the screen it was set from, and a closure typed
against the wrong date is a mistake somebody should be able to correct without being made to
prove themselves. Stated here so that the omission is a decision rather than something to
infer.

**A day that has gone is refused.** A reminder is only ever held on the day it would have
arrived, so closing a past day changes nothing that will happen. Refusing it, with a sentence
that says why, is better than accepting a row that does nothing. Today itself is allowed: it
has hours left in which to hold something.

**Validated where the person is, and where the answer is knowable.** "Has that day gone" is
worked out in the viewer's timezone, never the server's (§26.5). "Is that a day at all" is
worked out in the application, because the `date` column's own refusal is
`date/time field value out of range` — a person who types the thirtieth of February should get
a sentence.

## What is deliberately not built

**An organization-wide closure.** A company with one department at the top of its tree already
has one: set the day there and everything inherits it. A company with several roots would have
to set it on each, which is worth fixing when somebody has that shape, and is not worth a
second table and a second inheritance rule before then.

**Recurring closures.** "Every year on the second Monday of August" is a rule, and rules about
dates are what the four calendars are. A closure is one day, entered when it is known.

**Telling everybody.** A closure changes when people are chased, and the reminders screen
already shows each person the days ahead they will not be chased on — including this one. A
notification to every member of a department would be a message about something they can
already see, which is the thing ADR 0047 exists to avoid.

## Consequences
- `department_closures` is forced-RLS like every other tenant table, with one live closure per
  department per day; the partial unique index means a reopened day can be closed again.
- A reminder held by a closure carries its name: "Not delivered: Immingham depot stocktake
  where they work." The ladder still delivers on the next working day rather than dropping it.
- The demo has one — Operations is shut for a stocktake — so the screen shows a real closure
  and the acceptance loop closes, holds, reopens and delivers a real reminder around one.
- `workingCalendarFor` carries the closed days for one person, bounded to the last year: the
  only questions asked of a closure are whether to hold something today and where to schedule
  something ahead, and a shutdown in 2021 bears on neither.
