# ADR 0060 — The instrument that cried wolf

**Status:** accepted · **Date:** 2026-08-19

## Context

`scripts/column-coverage.ts` asks one question — *which tables and columns does live code read
from that nothing has ever written to?* — and the answer has chosen every increment for eleven
releases. That makes it the most expensive thing in the repository to be wrong about. It does not
produce a bad answer; it produces a bad **question**, over and over, and nobody notices because
the output looks like work.

It has been wrong three times already, each recorded in its own header: a regular expression that
could not see a conditional SQL fragment and so reported a settable control as unsettable; a
statement scanner that stopped at the first backtick inside an interpolation and truncated every
assignment after it; and a blind spot for columns a trigger maintains. All three were the same
shape — under-reporting a write, so a control that existed looked missing.

Re-deriving the queue after ADR 0059 turned up the opposite failure, which is worse because it is
silent about being loud. Of 127 candidates, **twenty-one were not candidates at all**:

- **Fifteen were timestamps whose default calls the clock** — `occurred_at DEFAULT now()`,
  `applied_at`, `granted_at`, `placed_at`, `valid_from`. The database writes them, correctly, and
  application code naming them would be the bug rather than the fix. The detector reported each
  as "written by nothing at all", which is true and misleading in the same breath.
- **Six were columns a CHECK pins to a single value.** Five of them are §29.5's prohibited
  monitoring settings — covert monitoring, keystroke and screen capture, automated employment
  decisions, reading private messages, scoring individuals — held to `false` by
  `monitoring_prohibited_by_design` since migration 0001. The sixth is
  `disclosures.visible_to_subject`, held to `true` by `disclosure_never_covert`, which is §29.3.
  For these, having no writer **is the guarantee working**. The detector filed them under
  "dead, or waiting for its feature".

A fifth of the queue was noise, and the noisiest part of it was the part that must never become
work.

## Decision

**Both classes are read out of the database, not kept in a list here.** A hand-written exception
list is a second place a fact lives, and two places drift — which is the finding ADR 0059 is
about. Postgres already knows both things.

**Stamped by the database.** A default matching `now()`, `current_date`, `clock_timestamp()` and
the other spellings of the same idea is a writer. These are listed in a section of their own,
excluded from the headline count, and the section says what is and is not known about them:

> right where the moment recorded is the insert; read one of these as work only if the moment it
> names could ever be a different one

That caveat is doing real work. `subscriptions.period_start` is in this section and a billing
period is not an insert; it is on the queue for its own reasons and the section does not pretend
otherwise. The rule also only fires when **nothing else** writes the column, because a clock
default on a column the seed also fills is still a column whose value is whatever the seed said —
`messages.sent_at` is when a message was sent, not when the row was written, and hiding it behind
its default would lose exactly the signal the detector exists for.

**Pinned by a constraint.** A CHECK that is *nothing but* `column = <literal>` joined by `AND`
means the column can hold one value. The parser is deliberately narrow: `CHECK ((status =
'failed') = (error IS NOT NULL))` contains the text `status = 'failed'` and pins nothing, and a
detector that mistook the second for the first would quietly retire a genuinely empty column from
the queue for good. Narrow and occasionally silent beats wide and occasionally wrong, for an
instrument that chooses work.

**For pinned columns the detector inverts, and a product write is the finding.** The CHECK refuses
the value; this refuses the code path. They are not the same statement: product code could write
`covert_monitoring = false` explicitly, pass the constraint, and leave behind a code path somebody
later changes a literal in. So `pnpm check:columns` exits non-zero if anything outside `tests/`
or a migration writes a pinned column, and **CI runs it**. A guard nothing runs is a comment.

A *test* writing one is not an offence — it is how the refusal gets proved — so the report says,
per pin, whether anything tries to defeat it.

## What it found on its first run

Four of the five §29.5 pins had **no test attempting them**. The one that did was inside a test
named *"states the five things no setting can turn on"*, which asserted the list had five entries
and then tried exactly one of them. A guarantee asserted for a fifth of itself is a guarantee by
adjacency. All five are now attempted, and so is `disclosures.visible_to_subject` — on INSERT as
well as UPDATE, which is the half a later UPDATE would not have caught.

The first version of those five attempts interpolated the column name (`SET ${sql(column)} =
true`), and the detector went on reporting "no test tries to defeat it" — correctly, by its own
stated blind spot: a write built out of interpolated identifiers is invisible to it. The test was
right and uncountable. Naming each column in full is clearer anyway, and it means the instrument
can see the thing it asked for.

## And one the wiring found immediately

`ROOT` was a string literal: one developer's home directory, hardcoded for eleven increments,
because that developer's machine was the only thing that had ever run the detector. The CI step
failed before reading a file — `ENOENT: scandir '/home/runner/work/Superwork/Superwork'` — which
is the same error in the other direction. It is now derived from the script's own location, and
`tests/unit/column-coverage.test.ts` checks both halves: that `ROOT` finds this repository
wherever it sits, and that the source contains no absolute path literal at all. The first
assertion passes on the machine where a hardcoded path happens to be right, which is exactly the
machine where nobody notices; the second is about the mechanism.

Putting a tool in CI is how you find out it was never a tool, only a habit.

## Consequences

- The queue is **108 candidates, not 127**, and every one of them is a question worth asking.
- Turning on covert monitoring, keystroke capture, automated employment decisions, reading private
  messages or individual scoring now requires defeating a database constraint **and** a red build,
  and each is attempted by name in `tests/security/governance-controls.test.ts`.
- `tests/unit/column-coverage.test.ts` tests the two new classifiers against the shapes
  `pg_get_constraintdef` actually returns, because their failure mode is silence: a column wrongly
  classified drops out of the queue and is never asked about again. The script now guards its own
  entry point so it can be imported without opening a database.
- The blind spots are still in the header, and one of them bit during this change. That is the
  argument for keeping them written down rather than tidied away.
