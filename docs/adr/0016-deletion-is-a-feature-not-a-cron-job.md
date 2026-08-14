# ADR 0016 — Deletion is a feature, not a cron job

**Status:** accepted · **Date:** 2026-08-14

## Context
Three things were true at once, and all three were embarrassing.

Migration 0009 created the append-only trigger on `audit_logs` and, in its own header,
described the exception: history may only be removed "by the retention and erasure jobs".
Those jobs were never written. The only way out was a door the migration promised and did
not cut.

`purgeDocument` has existed in `packages/core/src/retrieval/ingest.ts` since Phase 1. It
removes a document, its chunks, its embeddings, its citations and the memories derived from
it, in one transaction. Nothing called it. §25.13 — "deleting a document must delete its
chunks, embeddings and memories" — was satisfied in principle by a function no user could
reach, because there was no way to delete a document at all.

And nothing said how long anything was kept. The compliance screen could name a jurisdiction
profile and the constraints it imposes; it could not answer "for how long", because there was
no number anywhere to answer with.

A product that stores a transcript of somebody's meeting, and a record of every question the
assistant was asked about them, cannot leave "how long do you keep this" unanswered.

## Decision

**Retention is a row per class, not a constant.** Seven classes — agent runs, tool calls,
meeting transcripts, notifications and nudges, resolved insights, the API request log, the
audit trail — each carry a window in `retention_policies`. A class with no row falls back to
the default for the organization's jurisdiction profile, and the screen says so: *"The default
for works council. Nobody has changed it."* An organization that has never opened the screen
still has an answer, and the answer is the strict one.

**Every class has a floor, and the audit trail's floor is two years.** `minimumDays` is a
constant in code, not a column, so no configuration can go under it. The audit trail's floor
is 730 days and its default is the longest of the seven, because the trail is what makes every
other claim in this product checkable. Shortening it to nothing would be the single most
effective way to make Superwork untrustworthy, so it is the single hardest number to move.

**A window cannot be changed without a reason and a re-typed password.** `retention.set` is a
step-up action (ADR 0015) and the reason is a `CHECK` constraint, not a form validation:
`length(btrim(reason)) >= 8`. Shortening a window deletes, on the next sweep, everything
already past it. That is destruction on a timer, decided once and executed silently
thereafter, which is exactly the shape of change that should cost something to make.

**The audit trail is purged by the owner role, alone.** Every other class is purged by
`superwork_app` under RLS. `audit_logs` cannot be — the `DELETE` privilege is REVOKEd from
that role and the 0009 trigger refuses it besides, which is two defences and both of them
intentional. So the audit branch of `purgeClass` is the one statement in the product that runs
on `adminSql()`, and because the owner connection has no RLS to fall back on, that statement
carries `organization_id = ${org}` in its own text. The comment above it says as much. It is
the door 0009 promised, cut exactly once, in the open.

**A run waiting for approval is not old.** The `agent_runs` purge only removes finished runs.
A run that has been sitting in the approval queue for two hundred days is not stale data, it
is outstanding work, and deleting it would silently destroy a request somebody made.

**Erasure has three dispositions, and the third one is the honest one.** For each of eleven
tables the plan says *delete*, *anonymise* or *keep*, with a basis in plain English:

- **Delete** what is only theirs and only about them — their nudges, their notifications,
  their briefings, their sessions, their notification preferences.
- **Anonymise** what is other people's work with their name attached — tasks, commitments,
  transcript segments, agent runs. Deleting a task because the person who owned it left would
  destroy the record of work the company still has to do.
- **Keep**, on a stated basis, the audit trail and the disclosure log. The audit trail is the
  record that a decision was taken and by whom, and the disclosure log is the record of what
  was said about a person to somebody else. Erasing the disclosure log to protect a person
  destroys the only proof they have that nothing was said behind their back. Both are named on
  the preview screen with their basis, rather than quietly excluded.

**The preview is the product.** `previewErasure` counts every line and computes the blockers —
a sole owner of the organization, an active workflow naming them as the accountable owner —
before anybody can press anything. The execute button does not exist until the preview has
been read, and it is disabled until a reason is typed. There is no undo, so the last honest
moment is before.

**What outlives the person is not their name.** Anonymised rows point at a single tombstone
user (`erased@superwork.invalid`, displayed as "Erased"); the erasure request itself stores
`subject_label` — *"A former member of this organization"* — and a `CHECK (subject_label !~
'@')` stops anybody from putting an address there later. `subject_user_id` is set to `NULL`
when the erasure completes, so the record of the erasure is not itself a record of the person.

**Delete before anonymise.** The order is load-bearing and commented in the code: anonymising
first would reassign rows to the tombstone that the delete pass was about to remove, leaving
the tombstone user holding somebody else's deleted notifications.

**Nobody can erase themselves.** An owner erasing their own account would remove the only
person who could undo it, and would look identical to an attacker with a stolen session
covering their tracks.

**Deleting a document counts what went with it.** `deleteDocument` reads the chunk, citation
and memory counts *before* calling `purgeDocument`, and writes them into the audit diff. The
UI states them before, as a warning, and the API returns them after, as a fact. A cascade
nobody can see is indistinguishable from a cascade that did not happen.

## Consequences
- The worker sweeps retention every 24 hours and logs what it removed per class per
  organization. The sweep is idempotent and batched (`LIMIT`), so a long-neglected
  organization drains over several days rather than locking a table for minutes.
- `applyRetention` writes `last_applied_at` and `last_purged` back to the policy row, which is
  what the screen shows. "Not yet run" is a legitimate and visible state.
- The seven windows are per class, not per record. A single meeting cannot be pinned; a legal
  hold on one matter is not expressible. That is a real gap and it is named in the README
  rather than papered over.
- Erasure removes the membership first and the `users` row only if no other membership
  survives, because a person may belong to more than one organization and erasing them from
  one is not erasing them from all. `audit_logs.actor_id` deliberately has no foreign key to
  `users`, which is what allows the account to go while the history stays.
- The two *kept* classes are kept differently. The audit trail is untouched — it is append-only
  for the application role and refuses `UPDATE` for every role, so the identity is severed by
  removing the account it points at rather than by rewriting the rows. The disclosure log is
  repointed at the tombstone in place: the record that a disclosure happened survives, the
  name does not.
- Both screens live behind `owner`. There is no self-service erasure, because verifying that a
  request came from the person it names is a problem this product does not solve — and a
  self-service erasure endpoint with a weak identity check is worse than none.
