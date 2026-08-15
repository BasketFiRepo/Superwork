# ADR 0040 — One writer for what the model cost

**Status:** accepted · **Date:** 2026-08-15

## Context
`agent_messages` was created in migration 0003 with `role`, `content`, `task_class`, `model`,
`tokens_in`, `tokens_out`, `cost_cents`, `latency_ms` and `simulated`. Nothing has ever
written a row.

Cost was kept as a running total on `agent_runs`, incremented by `addUsage` on every model
call. So the AI ledger could say a run cost four cents and could not say which step, which
model, or how long any of it took — and the run page showed a figure with nothing behind it.

Looking at the ten call sites to fix that turned up something worse. There were already **two**
writers of model spend and they had drifted:

- `addUsage` incremented the run's totals; `recordUsageRecord` wrote the metering row. They
  were called side by side at *most* call sites — three of four in the nervous system, and the
  act path's narrative call had no metering row at all. That model spend never reached the cap
  it was supposed to count against.
- Both the ask and act paths **also** wrote a `unit = 'agent_run'` usage record carrying the
  run's *whole* cost, on top of the per-call rows. `spendSnapshot` sums `cost_cents` across
  every unit, so an ask run was counted roughly twice. Month-to-date AI spend was inflated and
  the §19.2 spend cap tripped at about half the real figure — and the same double count
  reached the billing screen's per-unit and per-task-class tables.

## Decision

**One writer.** `recordMessage` replaces `addUsage`. It writes the `agent_messages` row and the
metering row for the same call, from the same numbers, in the same transaction. There is no
longer a call site that can remember one and forget the other.

**The run's totals belong to the database.** A trigger recomputes `tokens_in`, `tokens_out` and
`cost_cents` on `agent_runs` from the messages. This is the pattern ADR 0028 named and 0030,
0032 and 0036 followed: when two places must agree, the agreement is not something application
code should be trusted to remember. Recomputed rather than incremented, so a deleted or
corrected message leaves the total right rather than drifted by the amount of the correction.

**A run-level usage record counts the run, not its cost again.** The `unit = 'agent_run'` row
stays — the ledger counts runs from it — with `cost_cents` of zero. The cost lives on the
per-call rows, once.

**`content` is what the model returned.** The request is already on the run and the system
prompt is a product constant rather than per-run data, so neither is copied for every call. It
is capped, and it is gated by the run: reading a run is what entitles somebody to what the run
did, the same rule its steps, citations and tool calls already follow.

**The detail does not age out separately from the total.** Messages are not given their own
retention scope; they go when their run goes, by cascade. Purging them independently would
make the trigger recompute the run's totals to zero, so a run whose detail had aged out would
claim it had cost nothing — worse than keeping the detail.

## Consequences
- The run page gains a "Model calls" table: what for, which model, tokens in and out, latency,
  cost, and the first line of what came back. It says the totals above it are the sum of those
  rows, because they now are.
- The AI ledger gains "Where the spend went", by model and by task class, read from the same
  rows the run totals are derived from — so the month's figure and the breakdown are one
  number rather than two that have to agree.
- The demo seeds one finished run with its two model calls. It seeds the calls and **not** the
  run's totals, which the trigger computes: if the seed stated them, it would be a second
  place that has to agree. Before this the demo had no `agent_runs` at all, so `/activity`
  listed nothing and the ledger reported zeros.
- Simulated output is recorded as such per call, and badged wherever it is shown (§5.12).
