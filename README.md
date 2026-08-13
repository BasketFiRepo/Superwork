# Superwork

An agentic AI operating system for company work.

Most work software stores work. Superwork **does** work — and the unit of value is a
completed operational loop: something happened → it was noticed → it was understood in
context → an action was proposed → a human approved it → it was executed → the result was
verified → everyone can see what occurred and why.

This repository implements Phase 0 (foundations) and Phase 1 (one closed loop) of the
build specification, end to end, **with zero external credentials**.

---

## Running it

Requires PostgreSQL 16 with `pgvector` and `pg_trgm`, and Node 22.

```bash
pnpm install
cp .env.example .env          # then set DATABASE_URL and SESSION_SECRET
pnpm db:reset && pnpm db:seed # schema + the Northwind Logistics demo organization
pnpm dev                      # http://localhost:3000
pnpm worker                   # outbox dispatch + watchers, in a second terminal
```

Sign in as `maya@northwind.example` / `superwork`.

`AI_MODE=mock` is the default. Nothing calls an external service; the agent reasons over
real rows from your database and every response it produces is badged **Simulated**.

```bash
pnpm test              # 287 assertions: units, tenant isolation, permission matrix
pnpm test:isolation    # the cross-tenant pack on its own
pnpm eval              # the agent eval harness — golden, adversarial and refusal packs
pnpm loop              # the Phase 1 acceptance loop, start to finish
```

## The acceptance criterion, and how to see it

> A new user can, in under ten minutes and with no external credentials: onboard → upload
> documents → ask a question and receive a cited answer → say "create follow-up tasks for
> the overdue items" → review a previewed plan → approve → see the tasks created, the
> activity logged, the cost recorded → and undo the entire run.

`pnpm loop` drives exactly that and asserts each step. In the interface it is: ask the
rail *"What is our liability cap for Halden Foods?"*, then switch to **execute** and say
*"Create follow-up tasks for all overdue customers."*

## Layout

```
apps/
  web                 Next.js app — UI, route handlers, SSE agent stream
  worker              Outbox dispatcher, watcher scheduler, email recall window
packages/
  config              Env schema (fails fast), model routing by task class, plan limits
  db                  Migrations, RLS policies, TenantContext, demo seed
  core                Domain logic: repositories, retrieval, audit, metering, health
  auth                Sessions and the one policy engine, `can()`
  ai                  Provider abstraction, context assembly, versioned prompts, mock brain
  tools               Tool registry and catalogue with risk tiers, inverses and previews
  agent               Runtime, gate, budgets, undo, watchers, eval harness
  integrations        Capability-shaped provider interfaces + first-class mocks
  ui                  Soft Paper design tokens
docs/adr              One record per irreversible decision
```

`packages/core` never imports from `apps/web`. Domain logic runs unchanged in the worker.

## The parts worth reading first

**The policy engine** — `packages/auth/src/policy.ts`. One `can()` function, three
consumers: the API boundary, the UI, and the agent tool layer. An agent's capability is
the intersection of the human it acts for, the organization's grant ceiling, its mode, the
tool's risk tier, and data classification. Denials explain themselves and name who can
grant access; cross-tenant attempts report absence, never denial.

**Tenant isolation, enforced three times** — forced row level security on all 66 tenant
tables under two non-superuser roles (`packages/db/migrations/0008_rls.up.sql`), a
`TenantContext` that no repository can be constructed without
(`packages/db/src/tenant.ts`), and a cross-tenant test pack that sweeps every table
(`tests/isolation`).

**Retrieval** — `packages/core/src/retrieval/`. Structure-aware chunking that never splits
a table, hybrid keyword + vector search fused with RRF and reranked, and the ACL predicate
*inside* both SQL arms so a chunk you may not read is never fetched. Below threshold it
says it has nothing rather than padding, and records the question so you can see what your
organization has failed to document.

**The runtime** — `packages/agent/src/runtime.ts`. Intake → Ground → Plan → Gate → Act →
Observe → Reflect → Report → Persist. The plan is produced and shown before anything
executes, and it is the unit of approval. Numbers come from `runAggregate` in SQL; the
model writes only the connective prose.

**Undo** — every write tool declares an inverse, and executing one records the compensating
call. `Undo this run` replays them in reverse and reports anything it could not reverse.
Irreversible actions were never executable without a human in the first place.

## What is deliberately not true yet

Controls for unbuilt features render disabled with the phase named — never as live-looking
no-ops. Inbox, meetings and CRM are behind feature flags; the workflow engine's tables,
versioning and simulation gate exist but natural-language authoring does not; approve-with-
edits is stubbed with an explanation. Nothing in the interface pretends to work.

## Safety properties this implementation actually holds

- **Nothing is auto-sent externally.** `send_email` is high risk, refuses a draft that is
  not approved, and enters a configurable recall window before dispatch.
- **Prompt injection is reported, not obeyed.** Untrusted content is fenced in its own
  context zone, scanned before indexing, and a run that reads an injected instruction is
  capability-downgraded and says so. The adversarial eval pack must pass at 100%.
- **Recipients come from the database, never from content.** An address that appears only
  inside a retrieved message is blocked.
- **Prohibited monitoring is unstorable.** Productivity scoring, covert monitoring,
  keystroke or screen capture, reading private DMs, and automated employment decisions are
  refused by a `CHECK` constraint. There is no admin setting that turns them on.
- **The kill switch is real.** It halts every run in the organization, marks in-flight runs
  `aborted_by_admin`, and is two clicks from any screen for an admin.

## Configuration

Every variable is validated at boot with Zod and the process refuses to start on a bad
config. `AI_MODE`, `EMAIL_MODE`, `CALENDAR_MODE`, `STORAGE_MODE` and `BILLING_MODE` each
resolve to `mock | sandbox | live`, and the resolved mode is rendered in the interface
wherever it affects what you should believe. `AUTOPILOT_ENABLED` is rejected while
`AI_MODE=mock`.
