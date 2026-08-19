# ADR 0057 — What was said, and when

**Status:** accepted · **Date:** 2026-08-19

## Context
`interactions` is the relationship timeline. The company screen reads it — ten rows, newest first
— and `last_interaction_at` is derived from it, which is what the quiet-account watcher acts on.

`logInteraction` has existed since Phase 3 and is reachable through `log_interaction@v1` **and
from nowhere else**. So a person who rang a customer this morning could watch the product decide
the account had gone quiet, and had no way to say otherwise except by asking the assistant to.

Reading it closely turned up three things worth more than the form:

**It had no permission check at all.** Not a weak one — none. That was survivable while its only
caller was a tool with `requiredPermissions: ['note:create:org']` of its own, and stops being
survivable the moment a person-facing route calls it.

**The vocabulary lived in one tool's input schema.** `log_interaction@v1` declares
`z.enum(['email','call','meeting','note','task'])` and the column is bare `text` with no CHECK.
A vocabulary that exists only in an input schema is one that holds for exactly as long as nobody
writes another way.

**A row about nobody was writable.** `listInteractions` selects by `company_id`, so an interaction
attached to neither a company nor a contact is written and then never read by anything.

## Decision

**The gate is the one the tool already declares.** `note:create`, checked in the repository, so
the tool layer and the route cannot disagree about who may write to the timeline (§4.2 asks for a
check at both layers; the point is that they are the *same* check).

**The vocabulary moves into the database**, alongside the enum the tool keeps. Two places, and
deliberately: the enum gives the tool a typed input and a good refusal, the CHECK makes it true of
every writer.

**An interaction must be about a company or a person**, enforced both places.

**A date in the future is refused in the repository and not by a CHECK.** A constraint cannot call
`now()`, and — more importantly — a row that was legitimate when written must not become invalid
as the clock passes it. Constraints are for what is always true, not for what is true today.

**No audit record.** The interaction *is* the record: it carries who logged it, when it happened,
and when it was written. A row in `audit_logs` saying the same thing would be ceremony. It does go
on the activity feed, because a colleague about to ring the same customer should know somebody
already has.

**The date field defaults to blank, and blank means "now" on the server.** A date input pre-filled
from the browser's clock is the hydration mismatch this product has already been bitten by
(ADR 0055's postscript), and it also invites somebody to accept a date they never thought about.
A date entered without a time is taken as midday UTC, so "yesterday" cannot land in the future for
somebody ahead of the server.

## An observation, not a change

A **manager** cannot log an interaction. Their role carries `note:*:department`, and a company is
not in a department, so the scope is not satisfied — while a *member*, who has `note:create:org`,
can. That is the existing role table's shape and it predates this change; the tool has had the
same behaviour since Phase 3. It looks wrong, and changing role baselines is not something to do
quietly inside a form. Worth a decision of its own — and ADR 0055 is the stopgap in the meantime:
grant the one capability rather than moving somebody's role.

## Consequences
- The company screen can log a call, a meeting or a note, and the account stops being counted as
  quiet the moment somebody does.
- `interactions` gains a contact-side index, so "what have we said to this person" is no longer a
  scan; the company-side one has existed since migration 0003.
- Eight tests. Removing the permission check fails one of them — it was written to fail against
  the code as it stood.
