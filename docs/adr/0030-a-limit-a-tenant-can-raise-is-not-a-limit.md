# ADR 0030 — A limit a tenant can raise is not a limit

**Status:** accepted · **Date:** 2026-08-15

## Context
The plan a company is on was stated in three places, agreeing with each other by luck.

- **`plan_limits`** — seeded from `DEFAULT_PLAN_LIMITS` and read by nothing. The config
  module's own comment says: *"These defaults seed the `plan_limits` table; the database is
  the source of truth at runtime so limits can be changed without a deploy."* It was not.
  `checkSpendLimits` read the compile-time constant, so a limit could not be changed without
  a deploy — the precise opposite of the promise sitting above it.
- **`subscriptions`** — a tier, a seat count and an AI spend cap per organization, read by
  nothing. Neither the seats nor the organization's own cap did anything.
- **`organizations.plan_tier`** — the one the runtime actually read, with nothing keeping it
  in step with the subscription's tier.

The sharpest consequence was a refusal. When an organization hits its cap the agent stops
and says *"An admin can raise the cap in Settings → Billing"* — **and there was no such
control on that screen**. A refusal that sends somebody to a setting which does not exist is
worse than a plain no: it turns a working stop into a bug report.

## Decision

**One resolved answer, from the database.** `effectiveLimits(ctx)` reads the plan's row and
applies the organization's own tightening. A missing `plan_limits` row falls back to the
built-in defaults rather than to *no limit* — an unseeded table must not silently uncap an
organization — and the result says which of the two it used, so the screen can state its
source rather than imply one.

**An organization may tighten, never widen.** `tighter(plan, own)` treats `null` as "no
limit", so a plan without a cap can be given one and a plan with one can never have it
raised. This is the same rule as an approval policy (ADR 0026) for the same reason: a limit a
tenant can raise on its own is not a limit, it is a suggestion.

**Changing the plan is not a setting.** There is no self-serve tier control, because what a
company pays for is a commercial agreement and a button that appeared to change it would be
the fake integration §25 forbids. The screen says so where somebody would look for one.

**The tenant cannot rewrite the plans themselves.** `plan_limits` is not a tenant table and
the application role has no write grant on it — changing what a *plan* allows is an operator
action. That was already true; it is now asserted, because it is the property that makes the
tightening rule meaningful.

**The database keeps the two tiers in step.** Rather than pick one of
`organizations.plan_tier` and `subscriptions.tier` and rewrite every reader, the subscription
becomes the source of truth and a trigger keeps the older column true. Same shape as the
jurisdiction history (ADR 0028): when two places must agree, the agreement is not something
application code should be trusted to remember.

**Seats are a hard limit, enforced where they are consumed.** An invitation is refused when
every seat is taken, and **an outstanding invitation holds a seat** — counting only accepted
ones lets somebody invite a hundred people onto twenty-five seats and find out when they
arrive. The refusal does the arithmetic, because "no seats" without it is a support ticket.
This closes the gap ADR 0029 named and deferred; the product decision it was waiting on —
refuse, warn, or allow overage — is *refuse*, matching how a spend cap already behaves.

## Consequences
- `spendSnapshot` still accepts a `tier` argument and ignores it. Callers need not change,
  and the parameter is documented as ignored rather than removed: it came from
  `organizations.plan_tier`, which is now derived rather than authoritative.
- A fixture organization has no subscription, so it resolves to the free tier's three seats —
  and the test fixtures have four people. That is the seat check working, and the packs that
  invite now create a subscription, which is what a real organization has.
- Tightening a cap records who and why. The agent stopping is the moment somebody asks who
  set the number, and a bare integer does not answer.
- `plan_limits.agent_runs_per_month`, `documents_indexed`, `storage_gb` and
  `workflow_runs_per_month` are resolved and displayed but not enforced. Only the spend caps
  and seats stop anything. Naming that is better than four more half-checks.
