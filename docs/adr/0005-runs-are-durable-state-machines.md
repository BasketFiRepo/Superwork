# ADR 0005 — Agent runs are durable state machines, not in-memory promises

**Status:** accepted · **Date:** 2026-08-13

## Context
An agent run can pause for days waiting on an approval, and must survive a deploy, a
process restart and the user closing the tab.

## Decision
Each phase of a run opens its own short transaction and persists before proceeding.
`agent_runs` holds the state; `agent_steps` holds the trace; `tool_calls` carries an
idempotency key derived from `(run_id, step_id, args_hash)` so a resumed run can never
re-execute a completed side effect. Live streaming is a *view* over that record: the
in-process event bus replays what was already written, and a client that disconnects
loses the stream, not the work.

## Consequences
- A run awaiting approval consumes no connection, no lock and no worker slot.
- Reconnecting replays the trace from the database.
- The in-process bus is single-node. Multi-node deployment needs a shared transport
  (Redis pub/sub or Postgres `LISTEN`/`NOTIFY`); the `publish`/`subscribe` pair in
  `packages/agent/src/bus.ts` is the seam, and nothing else depends on its internals.
