# ADR 0071 — A next step that is already true

**Status:** accepted · **Date:** 2026-08-21

## Context

`contacts.next_step` and `contacts.next_step_at` were added in migration 0010 and nothing has
ever written either. `SELECT_CONTACT` reads both into every `ContactView`, and no component
renders either one. The contacts table on the company page shows **Name · Email · Last touch** —
it answers "when did we last speak to this person" and drops the answer to "what happens next
with them" on the floor.

The obvious repair is to make them settable: a text box and a date on a contact, the way every
CRM has one. That is the wrong repair here, and the reason is the rule this codebase keeps
writing ADRs about — when two places hold the same fact, they disagree.

This product already has three places that mean "something is owed, and here is when":

- **commitments**, which carry a counterparty contact, a due date and an obligation, and which
  somebody has accepted;
- **follow-ups**, on a thread or an account;
- **tasks**, with dates and owners.

A free-text next step on the contact would be a fourth, reconciled with none of them. Somebody
would type "call Ingrid Thursday" while the commitment ledger says Wednesday and a follow-up
says next week, and the screen would show whichever of the four nobody had got round to
correcting.

## Decision

**The next step is derived, and the columns are dropped.** A commitment somebody is the
counterparty to, and a meeting they are coming to, are both contact-scoped, both dated, and both
already true. So the next step is a *read*, computed where it is shown, and there is nothing to
keep in step because there is no second copy. What was missing was never a place to write; it
was the query.

Dropping is safe in the one case where dropping ever is: the columns are empty in every row of
every database, because nothing has ever written them. The down script re-adds them and they
come back exactly as they were — present, and holding nothing.

**Only an accepted promise counts.** `confirmed` is what this codebase means by outstanding
everywhere else — `commitmentHealth` counts exactly those — so a proposal nobody has accepted is
not a next step. ADR 0066 built the ledger on that distinction and this is not the place to
quietly undo it.

**An overdue promise is still next; a past meeting is not.** The asymmetry is the point. A date
that has passed on a promise is what is next *and late*; a meeting that has happened is history.
The overdue promise therefore sorts first, which is the order somebody opening the account
actually needs.

**Company-level follow-ups are deliberately not folded in.** A follow-up on the Halden account is
about the account. Showing it against all four people at Halden would be four rows saying the
same thing about none of them.

**The demo says who the counterparty is.** Commitments seeded from a meeting take the outsider in
the room as their counterparty — when there is exactly one. With two, the room names none this
can attribute, so it attributes none rather than guessing.

## On reading two tables the caller was not gated on

The derivation reads `commitments` and `meetings` from inside a query gated on `contact:read`.
That is not a widening: every role holding `contact:read` also holds `conversation:read` (the
gate on `listCommitments`) and `project:read` (the gate on the meetings reads), at the same
scope — all three are in the viewer baseline, and a guest holds none of them.

But "it happens to be true today" is not a control. The test walks every role in
`ROLE_PERMISSIONS` and asserts the implication directly, so a future edit that grants
`contact:read` without the other two fails the build rather than quietly leaking a diary.

## Consequences

- The contacts table gains a **Next** column: a date, whether we owe it or they do, and what it
  is — or "Nothing scheduled.", which is a fact worth reading rather than a dash that looks like
  a column that failed to load.
- Ingrid Solberg at Halden Foods reads "we owe · Confirm the Gothenburg inbound window with
  Coldstore" in the demo, sourced from the sentence Sarah says in the transcript.
- `ContactView.nextStep` is one object rather than two loose columns, so nothing downstream can
  hold a date without the thing it is the date of.
- `contacts.next_step` and `contacts.next_step_at` come off the detector's queue — and off the
  schema: **99 → 97**.
- `commitments.counterparty_contact_id` comes off it too, without being the point. It was read
  and never written: the ledger had a column for the person on the other side of a promise and
  every seeded promise left it empty. The read that needed it is what made that visible, which
  is the usual way round.
