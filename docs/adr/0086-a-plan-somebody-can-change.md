# ADR 0086 — A plan somebody can change

**Status:** accepted · **Date:** 2026-08-24

## Context

ADR 0030 made the plan mean something. It found `plan_limits`, `subscriptions` and
`organizations.plan_tier` stating the same fact three times and agreeing by luck, resolved them
into one answer read from the database, and gave an organization a way to **tighten** its own caps.

What it did not give anybody was a way to move the ceiling. Four columns, sixteen releases later:

| Column | Read by | Written by |
|---|---|---|
| `subscriptions.tier` | the runtime, every limit, the billing screen | the seed |
| `subscriptions.seats_purchased` | `seatCheck`, on every invitation | the seed |
| `subscriptions.status` | the billing screen | **nothing at all** |
| `subscriptions.period_end` | the billing screen | **nothing at all** |

So an organization was on the plan the seed gave it, permanently. `seatCheck` refused the
twenty-sixth invitation with *"withdraw an invitation, deactivate somebody who has left, or buy
more seats"* — and there was nowhere to buy one. The screen showed a status and a renewal date the
product could not produce.

And underneath that, a second finding: **the plan decided almost nothing anyway.**
`agent_runs_per_month`, `documents_indexed`, `storage_gb`, `workflow_runs_per_month` and
`autopilot_allowed` were all resolved from the catalogue, displayed on the billing screen, and
enforced *nowhere*. Every tier allowed exactly what every other tier allowed. A free organization
ran agents unattended, indexed a million documents, and fired unlimited workflows.

Which makes the two halves one piece of work: a plan you cannot change is a broken control, and a
plan whose limits stop nothing is theatre. Building either alone leaves the other absurd.

## Decision

### The billing system is not this one

Superwork holds no card and takes no payment. It holds the *consequence* of a payment — a tier, a
seat count, a period, a status — and asks a `BillingProvider` the three questions only a billing
system can answer: **what would this cost, did it go through, did the period renew.**

`BILLING_MODE` has been in the environment schema since Phase 0, read by nothing. It chooses the
implementation now. In `mock` — the default, and what CI and the demo run — the answers are
deterministic and locally generated, and every figure derived from them is badged **Simulated** on
the screen, exactly as an admin-authored HTTP tool's response is.

The mock's per-seat rates **are not prices**. Nobody agreed them and no invoice will match them.
They exist so the arithmetic on the screen is exercised, and the badge is how the screen says so.
A number whose provenance is hidden is worse than no number.

The provider is passed in rather than imported, the shape `attachFile` takes for storage (ADR
0085). That keeps `packages/core` out of `@superwork/integrations` and lets a test hand in a
provider that declines — which is the only way the `past_due` path is reachable, because the mock
always pays. A mock with a failure knob grows one more knob every increment until the knobs are
the thing under test.

### Who may

`billing:update` is the **owner's**, and no rung below.

That was not a fresh decision — `tests/security/permission-grants.test.ts` has used *"an admin may
read billing and not change it"* as its worked example of a capability an admin cannot mint since
ADR 0055. A first draft of this work granted it to `admin`, and that test failed. The test was
right: administering the organization and committing it to money are different acts. The owner
reaches it through `*:*:org` like everything else.

An admin keeps `billing:read`, and the **preview** is behind `billing:read` rather than
`billing:update` — knowing what an upgrade would cost is not the same act as buying one, and a
product that makes you commit to find out is a product that generates accidental purchases.

### Step-up, in both directions

Every other action in `STEP_UP_ACTIONS` asks in one direction and not the other, because one of the
two only ever narrows: tightening a throttle, raising a classification, removing a grant. The list
says so, action by action.

`billing.change` has no safe direction. Spending the company's money and stopping its service are
both things a lifted cookie must not do on somebody's behalf, so both ask. And because only a
person can step up, an API key holding a wildcard cannot change a plan even if somebody grants it
one — a structural guarantee rather than a rule in the route.

### What the preview says before anything is committed

Three things, and the second is the one that matters:

- **What it would cost**, from the provider, badged.
- **What would stop working** — computed by comparing the two catalogue rows on every axis in
  *both* directions, so a plan that is better on one and worse on another reads as both rather than
  as whichever the code happened to check first. Plus what the organization is already past: *"4,120
  documents are indexed and this plan allows 100. Nothing is deleted — nothing more can be indexed
  until you are under it."*
- **What cannot be done**, with the arithmetic. Thirty-two people do not fit on twenty-five seats,
  and **nothing here deactivates anybody to make a plan fit.** The refusal names what is using the
  seats, including invitations nobody has accepted, and leaves the decision with a person.

An upgrade is refused while a payment is outstanding; a downgrade and a cancellation are not. You
cannot buy more on an unpaid account, and trapping somebody on an expensive plan they cannot pay
for is the opposite of what the state is for.

### The period is a fact, not a decoration

Cancelling ends the plan **at the end of the period already paid for**, not today. Anything else is
Superwork keeping money for a period it stopped serving. Until that date nothing changes at all.

Once it passes: the organization drops to `free`, nothing is deleted, and everything already here
stays readable. New work is what the free plan allows.

A renewal is the worker's, hourly. Four endings, each written down and each told to the owner:
renewed, declined, ended, or — for a free plan that somehow carried an end date — released, because
free does not renew and asking a billing system to charge nothing for it is a request nobody should
have to explain. A declined payment retries in **a week**, not on the next pass: retrying a declined
card every minute is how a product gets its merchant account reviewed.

**Enforcement does not wait for the sweep.** `planAllowance` asks whether the period has ended
rather than trusting that the worker has written the consequence, because a limit that is off
whenever the worker is, is not a limit.

### The limits, and which kind each one is

Two are a **stock** and two are a **flow**, and the distinction is load-bearing: documents and bytes
are what the organization is holding *now*, so the limit says how much may be held; runs are what it
did this month, so the limit says how many may be started. Counting a stock per month would let
somebody index a million documents in twelve batches.

They are counted from the rows themselves, never from `usage_records`, because retention prunes
usage records on a schedule (§21) and a limit that quietly rises when the meter is pruned is not a
limit either.

A **dry run does not count** against the workflow allowance. Activation is refused until one has
passed (ADR 0012); charging the plan for the safety step teaches people to skip it.

`autopilot_allowed` is enforced through the ceiling ADR 0068 already built rather than a refusal:
where the plan does not allow unattended work, the agent proposes and the run's own timeline says
which limit dropped it. An autopilot that silently became an assistant is worse than one that says
why.

### `plan_limits` deliberately gains no writer

It has no `organization_id`. One row per tier, shared by every tenant in the installation — a write
from inside one organization would reprice all of them. It is the price list, not a setting, and a
tenant picks a row from it.

The column detector cannot see that distinction and will go on reporting its nine columns as
unwritten. That is the detector being right about the shape and wrong about the work, which is
better than a hand-maintained exception list drifting away from the truth (ADR 0059).

## Consequences

- An organization can change its plan, buy and release seats, cancel, and resume — with a reason, a
  fresh password, a preview, and an audit record naming what it gave up.
- `subscriptions.tier`, `seats_purchased`, `status` and `period_end` have product writers.
  `plan_changed_by`, `plan_changed_at`, `plan_change_reason` and `provider_reference` are added and
  read, so the screen can say who changed the plan, why, and what the billing system called it.
- Five limits that decided nothing now decide something, at four call sites and one ceiling.
- `seatCheck`'s refusal points at a control that exists, which is the same repair ADR 0030 made one
  level down.
- `BILLING_MODE` has a reader for the first time.
- Detector: **58 → 55**.

## The bug this turned up

`tests/security/organization-profile.test.ts` restored a `plan_limits` row it had changed by
setting `ai_spend_cap_cents = NULL` — with a comment reading *"put the shared plan row back: it is
not this tenant's to keep changed"*. The intent was exactly right and the value was wrong: the
fixture tenant is on `free`, whose cap is £5, not unlimited.

So that test left the free plan **uncapped for everything that ran after it**, in a table with no
`organization_id` and therefore no tenant boundary to contain the damage. It is restored from
`DEFAULT_PLAN_LIMITS` now rather than from a literal.

Found by a new test asserting that a downgrade to free reports a smaller AI budget as a loss, and
being told the free plan's budget was unlimited.

## Lesson

ADR 0030 resolved the plan into one answer and stopped there, because the question it was asking
was *"which of these three does the runtime read?"* — and once that has an answer, the work looks
finished. The question it did not ask was *"and can anybody change it?"*

A read path finished without its write path does not look unfinished from the read side. It looks
correct. Every screen renders, every limit resolves, and the only symptom is a refusal that names
a control nobody ever built — which is the same symptom ADR 0030 was written to fix, one level up.
