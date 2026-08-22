# ADR 0077 — A budget this agent runs under

**Status:** accepted · **Date:** 2026-08-22

## Context

`agents.budget` has been a `jsonb NOT NULL DEFAULT '{}'` since migration 0006. `SELECT_AGENT`
reads it into every persona the product builds, and **nothing consults it** — not the runtime, not
Agent Studio, not the governance screen.

The brake it belongs to is already built and already works. `packages/agent/src/budget.ts` stops a
run on steps, tool calls, spend, wall clock and tokens, halts honestly rather than degrading, and
sets the run to `budget_exceeded`. What it stops on is `DEFAULT_RUN_BUDGET`, a product constant,
because `newBudget()` is called with no overrides on every path there is.

So every agent in every organization ran under the same numbers, and the column that exists to say
otherwise was read into a view and dropped. `RunBudget`'s own comment has said what should happen
since it was written:

> Default per-run agent budget (§5.5). Organizations may tighten but not exceed plan caps.

This is that sentence, built.

**The seed made it worse in an interesting way.** The one thing that ever wrote the column wrote
`runsPerDay`, `tokensPerDay`, `spendPerMonthCents` and `maxActionsPerDay` — four keys from a
vocabulary `RunBudget` does not have and no code reads. A column nobody reads does not push back
on what you put in it, so what went in was plausible-looking and entirely fictional.

## Decision

**The runtime reads the agent's budget.** The agent is resolved before the budget rather than
inside `insertRun`, and `newBudget()` gets what the row says. An empty object is not "no limit" —
it is the product's own, which is what every agent had all along.

**Tightening asks for a reason and nothing else.** Deciding an agent may do less is the direction
that should be easy, and a control that interrogated somebody for setting a stronger limit would
be the wrong way round. A reason is required because a run that stops half way through reads as a
fault unless somebody wrote down that it was a choice.

**Loosening asks for a password.** It lets the agent do more with nobody watching — the same act
`workflow.throttle` and `custom_tool.limits` already ask about, so `agent.budget` joins them.
Dropping a limit altogether counts as loosening, because falling back to the product's own number
is still more than the tightened one.

**Above the product default is refused outright**, whatever proof is offered. An organization may
tighten, never exceed — the sentence `setCaps` says about spend, for the same reason: the ceiling
is a safety decision rather than a setting. This is now the third control with this shape, after
spend caps against `plan_limits` and `allowed_regions` against `provisioned_regions`.

**Only keys the runtime enforces.** `checkBudget` reads steps, tool calls, spend and wall clock;
tokens and parallelism are the model layer's business. A key nobody reads would be a setting that
silently does nothing — which is exactly what the seed's four invented keys were.

**The attribution triple**, because a limit that stops an agent mid-run is precisely the setting
somebody is asked about the following week.

## The second place a number lives, and how it is kept honest

`sw_agent_budget_within_default` carries the ceiling as SQL literals. That makes it the second
place `DEFAULT_RUN_BUDGET` lives, which is a real cost and is taken deliberately: the alternative
is a rule only application code keeps, and the whole argument of ADRs 0072 and 0074 is that such a
rule is one anything holding a connection can break.

The mitigation is the arrangement `schema-manifest.ts` already has with the migrations directory.
`tests/unit/agent-budget.test.ts` parses the ceiling out of the migration and refuses it the moment
it stops matching the constant — in both directions, so a key added to one and not the other is a
red build rather than a silent gap.

A trigger rather than a CHECK because the rules are about the shape of a jsonb document, and a
CHECK cannot run the subquery that needs.

## Consequences

- An organization can decide what one of its agents may do on a single run, and the run stops
  there and says so.
- The demo opens on both states: the researcher tightened to 8 steps with a reason, the others on
  Superwork's own numbers, with the panel saying which.
- The seed's four fictional keys are gone. The new trigger refuses them, which is how they were
  found.
- `agents.budget` comes off the detector's queue: **77 → 76**.
