# ADR 0050 — A budget that stops something

**Status:** accepted · **Date:** 2026-08-19

## Context
Every tool in the registry declares a rate limit. `Tool.rateLimit` is `{ perRun, perOrgPerHour }`,
it is a required field, twenty-odd built-in tools carry hand-picked numbers for it, and
`custom_tools` has two columns feeding it — **and nothing has ever read it**. The type system
enforced the shape of a limit the product enforced nothing about.

For a custom tool it was the shape this work keeps finding, one layer deeper. `per_run_limit` and
`per_hour_limit` are selected out of the row and handed to the registry by `buildCustomTool`, so
from the repository they look enforced and from the type they look settable — while
`saveCustomTool` never wrote either. Every admin-authored tool that reaches a system outside the
company has run on a migration default of 5 and 200, chosen for nobody in particular.

The budget is what stands between a looping agent and a supplier's API at three in the morning.
It was the one control in this area that did nothing.

## Decision

**The limits are enforced, from the calls that really happened.** `checkRateLimit` counts
`tool_calls` — the same source the workflow throttle counts (ADR 0046) — rather than a counter
held in a process that restarts. Two budgets, because they stop two different failures:

- **Per run** stops one plan doing the same thing over and over: the loop that drafts forty
  emails because a step kept coming back unsatisfied. A person experiences this as "it did the
  same thing forty times".
- **Per organization per hour** stops many runs adding up to the same thing. This is the budget
  somebody *else's* system feels, which is why it belongs to the organization rather than to
  whichever run happened to be last.

**Checked in both executors, and in one function.** The agent runtime and the workflow executor
both call tools; both ask the same question of the same counter. A budget enforced on one path
and not the other is not a budget.

**Not on undo.** `undo.ts` runs a tool to reverse something that already happened, and refusing
an undo because of a budget would leave the world in the state the budget was trying to prevent.
Stated here rather than left as an omission somebody has to infer.

**Not on MCP.** Those calls are read-tier only, carry no run, and record no `tool_calls` row —
and an API key already has its own enforced per-minute limit. A second budget there would be a
number nobody could see being spent.

**The refusal says which budget and what happens next.** The per-run message says to look at why
the step repeats; the per-hour message says the hour is rolling and it will run again by itself.
A refusal that does not say what would work is a wall.

**The custom-tool numbers are settable, with attribution and bounds.** 1–100 per run, 1–5,000 per
hour, and the hour may not be smaller than the run — a per-hour budget below the per-run budget
means a single run could never finish, which nobody meant to set. Refused in the repository with
the numbers in the message and again by a CHECK constraint, so "unlimited" stays unexpressible.
`limits_set_by` / `_at` / `_reason` follow ADRs 0044 and 0046: a chosen number names its chooser,
a default names nobody, and the screen says which it is looking at.

**Raising asks for a fresh proof; lowering never does.** Raising lets the tool reach an outside
system more often with nobody watching. Lowering one in a hurry — because a supplier just asked
you to — is exactly what should not need a password.

**Its own control, not part of `saveCustomTool`.** Editing a tool's definition drops it back to
draft and requires re-approval, which is right for a change to *what it does* and wrong for a
change to how often it may do it.

## What is deliberately not built

**Settable budgets for built-in tools.** Their numbers live in the tool's own source, next to
the thing they describe, and now mean something. Making twenty of them into rows would be a
settings screen for numbers nobody has yet had a reason to change; when somebody does, it is the
same pattern as the custom ones.

**A queue rather than a refusal.** A call over budget is refused, not deferred. Holding it would
mean a plan that appears to be running while nothing happens, and the run's own record would
stop describing what took place.

## Consequences
- A tool call refused by a budget records a failed step with `errorClass: 'rate_limit'` and the
  reason, so a run's record says why it stopped rather than merely that it did.
- The custom-tools screen shows both numbers, how many calls the last rolling hour holds, and
  who chose them — from the same count the gate uses.
- One end-to-end test drives a real workflow: it prepares a draft, a person approves it, and the
  budget refuses the tool at apply time with nothing written. That is the claim.
- `tool_calls` gains an index on `(organization_id, tool_name, created_at DESC)`, which the
  hourly count needs and which nothing else was serving.
