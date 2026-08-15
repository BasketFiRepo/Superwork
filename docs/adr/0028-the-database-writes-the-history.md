# ADR 0028 — The database writes the history

**Status:** accepted · **Date:** 2026-08-15

## Context
`jurisdiction_changes` has had a writer since migration 0012 — `setJurisdiction` inserted a
row for every profile change it made — and no reader anywhere in the product. *"Who loosened
this profile, when, why, and who approved it"* is the first question a compliance review
asks, and the answer sat in a table nothing selected from.

The missing reader was the smaller hole.

**The history recorded only what one function did.** Any other path — a directory sync, a
data migration, a script, an acceptance loop temporarily relaxing a profile to exercise the
escalation ladder — changed `legal_entities.jurisdiction_profile` with a plain `UPDATE` and
left no trace. This was not hypothetical: the phase 5 acceptance loop had been doing exactly
that since the previous increment, and nothing in the product could have told you.

**Consultation was not recorded at all.** Under a works-council profile, `consultation_status`
moving to or away from `agreed` switches §29 features on and off. That is at least as
consequential as a profile change, and `recordConsultation` wrote no history row.

## Decision

**The database writes the history, not the application.** A trigger on `legal_entities`
records every change to `jurisdiction_profile` or `consultation_status` in the same statement
that makes it. There is no code path — supported, unsupported, or not yet written — that can
move either one without producing a row, because the row is not a separate call that can be
forgotten.

`setJurisdiction` no longer inserts. It *states the reason on the transaction*, through a
`set_config(..., true)` setting the trigger reads, exactly as row-level security reads
`app.current_org`. The reason is transaction-scoped, so it cannot leak from one caller into
the next on a pooled connection — there is a test for that, because a history that
attributes one person's justification to somebody else's change is worse than no history.

**An unexplained change is recorded, not refused.** A trigger that blocks the `UPDATE` gets
worked around by the next migration, and the change happens anyway with nothing behind it.
So a change arriving without a stated reason lands with `justified = false` and the text
*"Changed without a stated reason."* — and the compliance review fails on it. A change
nobody can see is worse than one that is visibly unaccounted for.

**Loosening is computed, not stored.** The direction a review cares about is derived from
the profile order at read time, so adding a profile later cannot leave old rows classified
by a stale rule.

**The columns are generic.** `from_profile`/`to_profile` became `from_state`/`to_state` with
a `change_kind`, because a consultation status is not a profile and a column named for one
holding the other is a lie that survives into every query written against it.

## Consequences
- The acceptance loop was the first thing the new record caught. It had been relaxing
  profiles with bare `UPDATE`s; the review immediately reported two unexplained changes. The
  loop now goes through `setJurisdiction` with a reason and a named approver — which is a
  better demonstration than the bypass was, and the fix was to the caller rather than to the
  check.
- Deleting a legal entity cascades its history away. That is correct — an entity that no
  longer exists has no history to review — but it means the acceptance loop reads the record
  before it cleans up after itself.
- `INSERT` is not covered. Creating an entity already at a loose profile produces no history
  row, because there is no change to record; `createLegalEntity` defaults to the strictest
  profile and loosening it is a separate, logged decision.
- `legal_entities.data_region` is not covered either. Residency is an organization-level
  setting elsewhere, moving it is a migration rather than a toggle, and the entity-level
  column has no setter at all. It is left alone rather than half-covered.
- The trigger falls back to the row's `created_by` when `app.current_user_id` is unset, so
  the history stays writable from a maintenance connection rather than blocking one.
