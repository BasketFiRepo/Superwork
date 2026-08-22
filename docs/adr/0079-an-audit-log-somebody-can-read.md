# ADR 0079 — An audit log somebody can read

**Status:** accepted · **Date:** 2026-08-22

## Context

`writeAudit` has been called from all over this product since Phase 0. Every classification, every
grant, every send, every erasure, every budget somebody set. The table is append-only, enforced by
a trigger since 0005 and by a `REVOKE` since 0008. It is one of the oldest things here.

Nothing has ever read it.

The only two queries against `audit_logs` in the whole repository are the retention sweep counting
rows to delete and the erasure preview counting rows about a person — both of which are about
removing entries, not reading them. There was no repository function, no screen, and no way for
anybody to look at what the product had recorded about their own organization.

Meanwhile `audit:read:org` has been in the administrator's grant list since the permission ladder
was built. The role list offered a capability the product could not perform.

That is the same failure the column detector was built to find, one layer up. The detector asks
which columns live code reads that nothing writes; this is a **permission the ladder grants that
nothing checks**. A new lens on the same question — where does the interface claim something the
product does not have — and the first thing it found.

## Decision

**Two readers, because they answer two different questions and only one of them is a privilege.**

`readAuditLog(ctx, actor, filter)` is gated on `can(actor, 'audit:read', …)`. It answers *what
happened here*: filtered by entity, by action, or by the account that did it. That last filter is
the one that makes a compromised account investigable, and it is the reason this is an
administrator's screen rather than everyone's.

`myAuditTrail(ctx, actor, limit)` requires no permission at all and cannot be pointed at anybody
else — it filters on `principal_user_id = actor.userId` in SQL, not in an argument a caller could
pass differently. §29.3 says nothing about a person reaches their manager that the person has not
already seen. An administrator can now read what a member did, so this is what makes that sentence
true rather than a thing the documentation asserts. It is on the personal record, next to what the
product says it never collects.

Both return the same rows from the same table, and a test asserts the two lists are identical for
the same person — because "you can see your own record" is worth nothing if it is a different,
gentler record.

## The grant that was never a control

Writing the screen's refusal is what exposed the real defect, and it is worse than the missing
reader.

A manager's rung carries `*:read:org` — *everything anybody here may read, across the
organization*. The resolver treats `*` as any resource type, so it matched `audit:read`. **Every
manager could already read the entire organization's audit trail**, including *"show me everything
this account did"*, for people they do not manage. `audit:read:org` sitting in the administrator's
list looked like the control; it never was one, because the rung below already matched. Nobody
noticed for the whole build, because nothing read the table, so the permission had never once been
evaluated.

That is not an administration screen. It is the individual monitoring §29.5 forbids, arriving
through a wildcard nobody had cause to think about.

**So a wildcard grant does not reach `audit`.** `NEVER_BY_WILDCARD` in `policy.ts` names the
resource types a grant must name explicitly. Both the administrator and the owner do — the owner's
`*:*:org` gained a second, explicit `audit:read:org`, because the owner holds everything by having
said so, not by a `*` that happens to cover it. An ADR 0055 exception still works and is now the
right shape for this: a manager investigating an incident should be handed the trail deliberately,
by somebody, on a record, rather than have quietly held it all along.

The set has exactly one entry and is meant to. Every addition takes a capability away from a role
that has it today; that is a decision per resource type, not a category anybody should extend by
intuition.

`requiredRoleFor` had the same bug, one layer along: it would have told Sarah *"You need Manager
access"* — the rung she is standing on, which is precisely the refusal ADR 0059 was written about.
It now applies the same rule and says **Admin**.

**A caught refusal is worth more than a passing read.** The beat that found this was not the one
asserting an administrator can read the log; that passed from the first run. It was the beat
asserting a manager cannot.

**A line names the redaction rather than hiding it.** `SENSITIVE_FIELDS` redacts at the logging
layer, so a password change is recorded as having happened with the field named and the value never
written down. The reader surfaces `redactedFields` as *"1 not recorded"*. Silence would be
indistinguishable from a field that never changed; "three fields not recorded" is a fact an auditor
needs.

**There are no totals.** Not on the screen, not in the repository, not behind either. `readAuditLog`
returns rows and never a count keyed on a person, and a source-reading test refuses the file the
moment a `GROUP BY principal_user_id` or a `count(` appears in it — the idiom ADR 0070 established
for digests, used here for the same reason.

The distance between this log and a thing §29.5 prohibits outright is exactly one `GROUP BY`.
*"What did this account do"* is a security question. *"How much did this person do"* is a measure of
them, and the difference between the two is only that nobody has written the second query. That is
not a difference a comment can hold, so it is a test.

**Two indexes**, which is the whole migration. `audit_logs_org_time_idx` from 0005 covers the
organization by time and cannot serve either read: `audit_logs_principal_idx` for *what has this
person done*, `audit_logs_entity_idx` for *what has happened to this record* — which is the
question somebody actually arrives with.

## What the trail holds to, and what it does not

The first version of the test asserted that nothing can ever delete a line. That is not what this
design promises, and writing the assertion is how the asymmetry got read properly. Migration 0009
replaced 0005's blanket rule with two:

- **Nobody may rewrite a line.** `UPDATE` is refused for every role, the owner connection included.
  A record somebody can tidy is not evidence.
- **The application role may not delete one.** The owner connection may — and that is the single
  path history leaves by, because retention sweeps and erasure both run through it. A trail that
  could never be trimmed would be a retention policy nobody could keep, and a GDPR erasure nobody
  could honour.

The screen said the first sentence and then overclaimed the second. It now says lines leave only
when the retention policy removes them, on a schedule set under Retention, and never one at a time.

**The refusal comes from the privilege system, not the trigger**, which the test discovered by
failing with the wrong error: `permission denied for table audit_logs` arrives before any row is
examined. That is the stronger of the two, because it does not depend on a trigger still being
attached — but it also means the trigger's `superwork_app` branch was unreachable, so nothing
proved it worked. An unexercised guard is a guard nobody knows the state of. So one test grants
`DELETE` back, attempts the delete, asserts the trigger refuses it anyway, and revokes in a
`finally`. Defence in depth is only depth if the second layer has been stood on.

## Consequences

**The column detector does not move: 75 before, 75 after, and the same 17 readings.** That is not a
failure of the increment, it is the point of it — this was found by a different instrument, and the
column detector was never going to see it. `audit_logs` has no unwritten column; every column in it
is filled by `writeAudit` on every insert. The table was fully written and entirely unread, which is
a shape the question "what does live code read that nothing writes?" cannot express.

- The oldest table in the product is legible for the first time.
- `audit:read:org` means something. It is now the control it was always presented as, rather than a
  line beneath a wildcard that had already granted it.
- Managers lose a capability they were never meant to have and nothing had ever exercised.
- A person can read what was recorded about them without asking the person it would be about.
- The new lens — granted permissions nothing checks — has one confirmed finding left on it:
  `task:complete` is in the ladder and never checked anywhere.

## Lesson

A permission with no feature behind it is a column with no writer, one layer up. The detector found
the first kind for thirty increments because somebody wrote it a query; the second kind went
unnoticed for the entire build because nobody had thought to ask.

And underneath that, the sharper one: **a permission that is never checked is never wrong.**
`audit:read:org` read correctly in the ladder, in the role documentation and in every review of it,
for the whole build — because no code path had ever asked the resolver the question, and the
resolver's answer was not the one the list implied. The permission was not merely unimplemented; it
was *wrong*, and building the feature is what made the wrongness expressible.

An instrument only finds what it was pointed at. A control nobody has exercised is not known to
work; it is only known to be written down.
