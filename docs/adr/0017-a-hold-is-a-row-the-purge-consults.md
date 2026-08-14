# ADR 0017 — A hold is a row the purge consults

**Status:** accepted · **Date:** 2026-08-14

## Context
ADR 0016 gave the organization a way to delete on a schedule and named the gap it left:
"retention windows are per class, not per record: a single meeting cannot be pinned and a
legal hold on one matter is not expressible."

That gap has a direction, and it is the dangerous one. Keeping data too long is a privacy
cost, argued about in advance, defensible with a stated basis. Deleting data that a matter
required be kept is spoliation — a finding against the company, discovered afterwards, that
no amount of good intent undoes. A product that automates deletion and offers no way to stop
it has automated the worse of the two failures.

## Decision

**A hold is a row the purge consults, not a flag on the records it protects.** Stamping
`held = true` on affected rows would only ever cover what existed the moment the hold was
placed, and most of what a matter covers arrives afterwards. It would also need a second
sweep to unstamp on release, which is a job that can fail halfway and leave records
preserved for a matter that closed.

**One predicate, consulted by every class.** `heldBy(sql, org, when, who)` builds a
correlated `EXISTS` against `legal_holds`, and each retention class supplies the two
fragments that make it specific: which timestamp the hold's window is compared against, and
what makes a row attributable to a custodian. Writing seven hand-rolled clauses would let
one class acquire a quietly different idea of "held" than the class beside it.

**`when` must be the column the purge already compares against its cutoff.** If the purge
called a run old by `finished_at` while the hold looked at `created_at`, a row could be past
its window by one column and outside the matter by the other — a leak on exactly the
boundary the hold exists to guard. Tying both to one column makes "held ⇒ not purged"
structural rather than a thing to remember.

**`who` is a predicate, not a column,** because attribution is not uniform. A run belongs to
its principal, a tool call to its run's principal, an API request to the person its key acts
as (ADR 0009), an audit row to whoever did it *or* whoever it was done for, and a transcript
to everybody who spoke in it — one custodian's line holds the whole record, because splitting
it would leave a transcript with holes where the other participants were, and that is not
preservation.

**Where there is no person, the hold takes everything in the period.** Insights are
observations about the organization, not about anybody, so a hold over the period holds all
of them. Over-preserving is the safe direction here, and it is stated on the screen rather
than left to be found out.

**No custodians means everybody.** A whole-organization hold is the ordinary case when a
regulator opens a file, and expressing it as an empty array rather than "enumerate all 4,000
people at the moment of placing" means it keeps covering people who join afterwards.

**`covers_to` is nullable and means "and everything since".** A live matter has no end date.
Forcing one in would stop preserving on a day nobody chose.

**Placing needs no step-up; releasing does.** The same asymmetry as the kill switch, for the
same reason. Somebody has usually just been told to stop deleting, and a password prompt
between them and that buys nothing the audit row does not already record. Releasing is the
irreversible half: the next sweep deletes what the hold was keeping and does not ask first.

**A hold refuses, rather than being outvoted.** Erasure and document deletion are the other
two ways records leave, and neither of them consults a retention window, so neither would
have noticed. Both now refuse while a hold covers the subject, and both name the matter — an
erasure request that fails without saying why sends somebody looking for a bug instead of
looking for counsel. When a right-to-erasure request and a preservation notice collide, both
are real legal obligations and only one of them can still be satisfied later, so the erasure
waits and the choice of whether to release is left with the people who placed the hold.

**Every named custodian is told, and it cannot be turned off.** This is the load-bearing
constraint. A hold that a person is not told about is indefinite retention of one
individual's records on somebody's private say-so, which is the exact shape §29.5 makes
unconfigurable everywhere else in this product. The notice goes into the disclosure log —
the place a person already looks to find out what is being done with what is theirs — where
the `disclosure_never_covert` CHECK from 0011 applies to it for free.

**The sweep reports what it left alone, per class.** `PurgeOutcome.held` is counted before
the delete, because afterwards a held row is indistinguishable from a row that was never due.
Without it, a hold that silently fails looks exactly like a hold that works.

**The retention screen says a hold is in force from the moment it exists,** not from the next
sweep. `last_held` is evidence about a sweep that has happened; a hold placed this morning
would have shown nothing until tomorrow, and a retention window that appears not to be
enforced is a support call.

## Consequences
- A hold notice cannot be suppressed, so Superwork cannot support a covert hold — the kind a
  fraud investigation would want, where telling the custodian tips them off. That is a real
  limitation and it is named in the README. An organization needing one has to go outside
  this product, under a court order, which is the right place for that decision to be taken.
- The purge does two queries per class per sweep instead of one. It is a daily job and the
  count is the only evidence the hold did anything, so the trade is worth making.
- Attribution is only as good as the columns. A document is held by who added it and when,
  because that is the only attribution the table carries; inferring one from its contents
  would be a guess wearing the clothes of a legal control.
- Holds are visible to `owner` only, and every one of them is in the audit trail twice —
  placed and released — with the basis and the release reason attached.
- A released hold is kept, not deleted. What was preserved, for what, and who decided to stop
  is the thing anybody would later be asked about.
