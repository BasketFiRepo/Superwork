# ADR 0074 — Somewhere the data may not go

**Status:** accepted · **Date:** 2026-08-21

## Context

`organizations.allowed_regions` was added in migration 0011 with `DEFAULT ARRAY['eu']` and nothing
has ever written it. It is not decorative — four things read it:

- `residency()` returns it,
- the identity settings screen renders every region against it,
- `setResidency()` refuses a move to a region that is not on it,
- and the schema refuses one too: `CHECK (data_region = ANY (allowed_regions))`.

So the data-residency panel offered three regions to every organization, permanently refused two
of them, and the refusal read:

> This organization is provisioned for eu. Moving to uk is a migration, not a setting.

naming a provisioning act that nobody, anywhere in this product, could perform. **A refusal has to
name what would work**, and that one named something that could not be done at all.

## Decision

The obvious repair — let an administrator tick "us" — is the wrong one, and for the reason §25
gives about fake integration buttons: **a settings screen cannot make infrastructure exist.** An
organization ticking a region it has no database in would be recording a claim about the world
that is simply untrue, and `data_region` would then be free to move somewhere there is nothing to
move to.

The shape this needs already exists in the product, one screen away. `plan_limits` holds the
vendor's ceiling and `subscriptions` holds the customer's own cap beneath it, and `setCaps` says
the rule out loud: *"an organization may tighten its limits, never widen them — changing the plan
is a commercial change, not a setting."* Regions are the same arrangement with a different
ceiling.

**`provisioned_regions` is the ceiling, and it is not a setting.** It is written where
provisioning happens — seeding, a migration, an administrator on the owner connection — and never
by the tenant runtime. No repository function updates it and no screen offers to.

**`allowed_regions` is the organization's own restriction beneath that ceiling.** "Our data must
never leave the EU" is a real thing a company wants to say and have enforced, and until now the
only way to say it was to already be in the one region the default allowed.

**Narrowing asks for nothing but a reason.** Making a stronger promise about yourself is the
direction that should be easy, and a control that interrogated somebody for it would be the wrong
way round. **Widening asks for a password** — the direction rule, unchanged since ADR 0044 — and
`settings.widen_data_regions` joins `STEP_UP_ACTIONS`. **Widening past the ceiling is refused
outright**, whatever proof is offered.

**The attribution triple** (`allowed_regions_set_by` / `_set_at` / `_reason`, with a CHECK) because
a restriction on where a company's data may go is exactly the kind of setting somebody is asked
about a year later, in a room where "it has always been like that" is not an answer.

**And the old refusal is split in two**, because there are now two reasons and they need different
answers from the reader: a region ruled out is one click and a password away, and a region nobody
provisioned is a migration. The single message called both "provisioned".

## What the database holds to

The repository is not the only writer worth defending against, so the rules are constraints:
`allowed_within_provisioned` (a subset), `allowed_regions_not_empty` (data has to live somewhere),
and `allowed_regions_attributed`. The tests write through `adminSql()` — the owner connection, the
most privileged writer there is — because a rule only the repository keeps is a rule anything
holding a connection can break.

Ruling out the region the data is *currently* in is refused by `data_region_allowed`, which 0011
already had. The repository catches it first so the reader gets a sentence rather than a
constraint name, but the guarantee is the database's.

## A note on the instrument

`provisioned_regions` is a new column the product deliberately cannot write, which is exactly the
category the column-coverage detector exists to surface — and the detector does not complain about
it, because 0065's backfill counts as a write. That is the instrument happening to agree rather
than anybody deciding, and this codebase has already recorded that an instrument which quietly
agrees with you is worse than none.

So the rule is asserted directly instead: a test reads `packages/core`, `packages/agent`,
`packages/tools` and `apps/web` for an assignment to the column and requires none, the way ADR
0070 asserts there is no per-person digest count. Anybody adding a screen for this has to delete
that test and argue with this ADR beside it.

## Consequences

- An organization can, for the first time, make a binding promise about where its data may be
  kept — and Superwork keeps it, at the API, at the schema, and on the screen.
- The demo is provisioned for the EU and the UK and has allowed only the EU, so the panel opens on
  the interesting state: one region a click and a password away, and one that is neither.
- The "not provisioned" chip was a `title` tooltip no keyboard could reach. It now says what would
  actually work, in text.
- `organizations.allowed_regions` comes off the detector's queue: **92 → 91**.
