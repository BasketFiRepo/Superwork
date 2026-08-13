# Superwork

An agentic AI operating system for company work.

Most work software stores work. Superwork **does** work — and the unit of value is a
completed operational loop: something happened → it was noticed → it was understood in
context → an action was proposed → a human approved it → it was executed → the result was
verified → everyone can see what occurred and why.

This repository implements Phase 0 (foundations), Phase 1 (one closed loop) and Phase 2
(the nervous system: inbox, meetings, CRM and the daily briefing) of the build
specification, end to end, **with zero external credentials**.

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
pnpm test              # 452 assertions: units, tenant isolation, permissions, briefing, injection
pnpm test:isolation    # the cross-tenant pack on its own
pnpm eval              # the agent eval harness — golden, adversarial and refusal packs
pnpm loop              # the Phase 1 acceptance loop, start to finish
pnpm loop:phase2       # triage → meeting → account → briefing, with assertions
pnpm check:browser     # walks Inbox, Meetings, CRM and the Briefing in a real browser
```

`pnpm check:browser` expects the app already running (`pnpm dev`, or `pnpm build && pnpm
--filter @superwork/web start`); point it elsewhere with `BASE_URL`.

## The acceptance criterion, and how to see it

> A new user can, in under ten minutes and with no external credentials: onboard → upload
> documents → ask a question and receive a cited answer → say "create follow-up tasks for
> the overdue items" → review a previewed plan → approve → see the tasks created, the
> activity logged, the cost recorded → and undo the entire run.

`pnpm loop` drives exactly that and asserts each step. In the interface it is: ask the
rail *"What is our liability cap for Halden Foods?"*, then switch to **execute** and say
*"Create follow-up tasks for all overdue customers."*

Phase 2 adds its own criteria: the daily briefing is accurate against a hand-audited day,
and the injection adversarial pack passes at 100%. Both are tests —
`tests/briefing/accuracy.test.ts` builds a day with known contents, checks every figure
against an independent count, and then asserts that **no number in the generated prose is
absent from the computed facts**; `pnpm eval` fails the run if a single adversarial
fixture regresses.

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

## Phase 2 — the nervous system

**Inbox** (`/inbox`) — a keyboard-driven triage queue ordered past-SLA first, then priority,
then oldest. `j`/`k` move, `e` archives, `s` snoozes, `f` marks waiting-on-them, `t` asks
for a task, `r` for a draft, `?` for the sheet. Every action is optimistic and rolls back
with a toast if the server disagrees. Message bodies are never rendered as HTML: remote
images are blocked and counted, scripts and frames are removed, and links from unrecognised
domains are marked external (`packages/core/src/sanitize.ts`).

**Commitments** (`/commitments`) — promises found in mail and meetings are recorded as
*proposals*. Until the named owner confirms one it counts for nothing, appears in no
rollup and triggers no nudge. The ledger separates kept, renegotiated in advance and
silently slipped, and only the third is worth escalating. See ADR 0007.

**Meetings** (`/meetings`) — transcripts are indexed with `MM:SS` citation anchors, so a
decision traces to the moment it was said. Summarizing records decisions and *proposes*
action items; turning them into tasks runs through the ordinary plan → approval → undo
path. An owner who was named but was not in the room is never assigned work; the summary
says who was mentioned and assigns nobody. A recurring series reports what it keeps
deferring.

**CRM** (`/companies`) — a 360° view assembled from threads, commitments, tasks, meetings
and documents, where every sentence corresponds to a row you can open. Duplicate contacts
are detected and merged field by field, with the loser tombstoned rather than deleted.

**Daily briefing** (`/briefing`) — every figure is computed in SQL in the reader's own
timezone; the model writes only the sentences between them. One recommended action is
chosen deterministically (blocking others → approvals → stale threads → overdue → due
today), and the basis line states the time the figures were computed.

## What is deliberately not true yet

Controls for unbuilt features render disabled with the phase named — never as live-looking
no-ops. The workflow engine's tables, versioning and simulation gate exist but
natural-language authoring does not; approve-with-edits is stubbed with an explanation.
Nothing in the interface pretends to work.

## Safety properties this implementation actually holds

- **Nothing is auto-sent externally.** `send_email` is high risk, refuses a draft that is
  not approved, and enters a configurable recall window before dispatch.
- **Prompt injection is reported, not obeyed.** Untrusted content is fenced in its own
  context zone and scanned on three roads into the context: at ingestion (a document that
  carries an instruction is quarantined out of retrieval), at grounding (flagged messages
  and retrieved passages downgrade the run's capabilities), and in the meeting summarizer
  (a flagged segment stays in the record but cannot originate a decision, a commitment or a
  task). The adversarial eval pack must pass at 100%.
- **Recipients come from the database, never from content.** An address that appears only
  inside a retrieved message is blocked.
- **Prohibited monitoring is unstorable.** Productivity scoring, covert monitoring,
  keystroke or screen capture, reading private DMs, and automated employment decisions are
  refused by a `CHECK` constraint. There is no admin setting that turns them on.
- **The kill switch is real.** It halts every run in the organization, marks in-flight runs
  `aborted_by_admin`, and is two clicks from any screen for an admin.

## Configuration

Every variable is validated at boot with Zod and the process refuses to start on a bad
config. `vercel.json` points the platform at the workspace build (`pnpm --filter
@superwork/web build` → `apps/web/.next`); a hosted deployment still needs `DATABASE_URL`
pointing at a PostgreSQL 16 instance with `pgvector` and `pg_trgm`, `SESSION_SECRET`, and
the migrations applied — the app boots against an empty database but every screen is a
sign-in wall until `pnpm db:seed` or a real organization exists. `AI_MODE`, `EMAIL_MODE`, `CALENDAR_MODE`, `STORAGE_MODE` and `BILLING_MODE` each
resolve to `mock | sandbox | live`, and the resolved mode is rendered in the interface
wherever it affects what you should believe. `AUTOPILOT_ENABLED` is rejected while
`AI_MODE=mock`.
