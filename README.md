# Superwork

An agentic AI operating system for company work.

Most work software stores work. Superwork **does** work — and the unit of value is a
completed operational loop: something happened → it was noticed → it was understood in
context → an action was proposed → a human approved it → it was executed → the result was
verified → everyone can see what occurred and why.

This repository implements the build specification end to end, **with zero external
credentials**: Phase 0 (foundations), Phase 1 (one closed loop), Phase 2 (the nervous
system — inbox, meetings, CRM and the daily briefing), Phase 3 (scale, trust and depth)
and Phase 4 (enterprise scale).

The specification stops there. Everything after it came from the product's own accounting
of itself, in two batches. First the three things this README already listed as not yet
true — natural-language workflow authoring, approve-with-edits, admin-authored HTTP tools.

Then a longer list, found by asking a blunter question: **which tables does live code read
from that nothing has ever written to?** Each answer was a control the interface was
claiming and the product did not have — step-up authentication, retention, erasure, legal
holds, the agent's memory, document circulation lists, task dependencies, teams,
feature-flag overrides, and sharing. Several were worse than gaps. The circulation-list check had been
running inside both arms of retrieval since Phase 1 and had never matched a row; the daily
briefing had been reporting on task dependencies that could not exist; and the `guest` role
could read nothing at all, because every permission it holds is team-scoped and no team
could be created.

---

## Running it

Requires PostgreSQL 16 with `pgvector` and `pg_trgm`, and Node 22.

```bash
pnpm install
cp .env.example .env          # then set DATABASE_URL and SESSION_SECRET
pnpm db:reset && pnpm db:seed # schema + the Northwind Logistics demo organization
pnpm dev                      # http://localhost:3000
pnpm worker                   # outbox, schedules and watchers, in a second terminal
```

Sign in as `maya@northwind.example` / `superwork`.

`AI_MODE=mock` is the default. Nothing calls an external service; the agent reasons over
real rows from your database and every response it produces is badged **Simulated**.

```bash
pnpm test              # 774 assertions: units, isolation, permissions, briefing, injection, ledger, studio, scale
pnpm test:isolation    # the cross-tenant pack on its own
pnpm eval              # the agent eval harness — golden, adversarial and refusal packs
pnpm loop              # the Phase 1 acceptance loop, start to finish
pnpm loop:phase2       # triage → meeting → account → briefing, with assertions
pnpm loop:phase3       # ledger → create/simulate/publish an agent → personal record → API key
pnpm loop:phase4       # fair scheduling → works-council review → nudge budget → sharing
pnpm loop:phase5       # describe → dry-run → activate → run → approve with edits → custom tool → memory → access → dependencies → teams → flags → sharing → projects → spaces → approval rules → reporting lines → jurisdiction history → invitations → plan limits
pnpm loadtest          # the §26.9 budgets, measured (SCALE=small|medium|large)
pnpm check:browser     # walks every screen in a real browser, including authoring a workflow
```

`pnpm check:browser` expects the app already running (`pnpm dev`, or `pnpm build && pnpm
--filter @superwork/web start`); point it elsewhere with `BASE_URL`.

There is one `.env`, at the repository root. The scripts read it with
`node --env-file=.env`; the web app reads it through `apps/web/next.config.mjs`, because
Next resolves its own env files relative to `apps/web` and would otherwise start a server
that answers every request with `DATABASE_URL: Required`. Real environment variables always
win over the file, so a platform that injects its own configuration is unaffected.

Every one of those runs on each pull request — `.github/workflows/ci.yml` builds the schema
against a real PostgreSQL 16 with pgvector, rolls the newest migration back and forward to
prove its rollback is real, then runs the types, the tests, the evals, all five acceptance
loops and the scale budgets in one job, and the browser walk over every screen in another.
The screenshots the browser check takes are kept as an artifact, because they are the
evidence for what it asserts about a screen. A green tick means those passed; it is not a
statement that the app merely compiles.

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

Phase 3 adds three more, and `pnpm loop:phase3` drives all of them: an admin can answer
from the interface exactly what the AI read, proposed, executed and cost last month per
department; an agent can be created, permissioned, simulated and published through change
control without an engineer; and every employee can open one screen showing what is held
about them and what was reported to whom.

Phase 4 adds three again. `pnpm loop:phase4` proves two of them — a bulk job of 120 runs
does not delay a department that queues four, and the works-council review answers ten
questions with evidence from this tenant's own rows. The third is measured rather than
asserted: `pnpm loadtest` builds a synthetic tenant, times the operations §26.9 states
budgets for, and prints the scale it actually reached beside the scale the target assumes.
At 5,000 users and 120,000 tasks every budget is met with the scoped list view served by an
index-only scan — evidence about query shape, and explicitly not a 100,000-user result.

## Layout

```
apps/
  web                 Next.js app — UI, route handlers, SSE agent stream
  worker              Outbox dispatcher, workflow and watcher schedules, email recall window
packages/
  config              Env schema (fails fast), model routing by task class, plan limits
  db                  Migrations, RLS policies, TenantContext, demo seed
  core                Domain logic: repositories, retrieval, audit, metering, health,
                      retention, erasure, legal holds, memory, teams, flags
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

**Tenant isolation, enforced three times** — forced row level security on all 90 tenant
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

## Phase 3 — scale, trust and depth

**AI ledger** (`/analytics`) — what the assistant read (citations), proposed (plan steps),
executed (tool calls) and cost (usage records) for a month you choose, by department, with
the runs behind every figure one click away. It groups by department and by agent and by
nothing else: ranking colleagues by AI usage is the report §29.5 prohibits, so the query
cannot produce it. See ADR 0008.

**What is known about you** (`/me`) — self-service and self-only. What is held about you,
who can see each category, every disclosure ever made about you and to whom, what is never
collected at all, and a download of the lot. Downloading is itself recorded, so the page
gains a row the moment you use it. Nobody — including an owner — can open it for somebody
else.

**Agent studio** (`/settings/agents`) — a persona is data: an owner, a purpose, named tool
grants, a mode ceiling, a clearance and autopilot caps, all enforced by the gate. Create →
permission → **simulate** → publish. Simulating runs the real grounding, planner and gate
under the proposed configuration and stops before acting; publishing needs a second person,
a justification and a version row you can roll back to. Widening changes are labelled as
widening. See ADR 0007's sibling, ADR 0009, for how the same rule applies to keys.

**Autopilot caps and digests** — unattended work is bounded by a daily action cap and a
weekly spend cap, counted in SQL against what actually happened. Hitting one pauses the
agent and routes the plan to a person rather than dropping it. Each agent owes its owner a
weekly digest, and everyone named in a digest gets a disclosure at the same moment.

**Integrations** (`/settings/integrations`) — capabilities, not vendors: email, calendar,
storage, chat, finance, CRM and identity, each with what degrades without it, a real health
check against the resolved provider, and a `Simulated` badge where that is what it is.

**Public API and MCP** (`/settings/api`) — keys act as a named person, hold scopes, are
rate limited from the request log, and appear in the audit trail. `/api/mcp` speaks MCP
over the same tool registry the agent uses, restricted to read-tier tools. `POST
/api/v1/runs` is capped at `assist`: an API caller can have work proposed, never executed
unattended.

**Identity and residency** (`/settings/identity`) — SSO and SCIM against a simulated
directory, previewed before it is applied, deactivating rather than deleting. Residency is
a property of the organization and refuses a region the tenant is not provisioned for
rather than pretending data moved.

**Usage and cost** (`/settings/billing`) — spend by unit, by task class and by department,
against the plan's caps, plus API call volume.

## Phase 4 — enterprise scale

**Fair-share scheduling** (`/settings/queue`) — runs are claimed through deficit weighted
round-robin held in the database, not started where they were created. A department that
queues two hundred jobs at nine o'clock gets its share of the workers and no more;
interactive work is scheduled ahead of bulk at equal weight; a department at its concurrency
cap is skipped rather than blocking. Weights, caps and the wait each department is actually
getting are on one screen. See ADR 0010.

**Jurisdiction profiles and the works-council review** (`/settings/compliance`) — a legal
entity starts on the strictest profile; loosening it needs a justification and a named
approver and is recorded. The review answers ten questions with live queries against this
tenant — most of them backed by a schema property rather than a runtime check, so the answer
cannot be massaged. It fails until a consultation is recorded, which is what makes the
passing version mean anything. See ADR 0011.

**The nudge ladder with a shared budget** — the ladder opens at the rung that fits now
rather than the one the calendar suggests, one action closes it, finishing the work cancels
it everywhere, and the daily budget belongs to the *person* and is shared across every
agent. Where the profile forbids manager escalation, that rung does not exist. Delivery goes
through chat where the capability is connected and degrades to in-app when it is not.

**Relation tuples** — sharing one project with a colleague is a tuple, not a role change.
Tuples are loaded once with the actor so a permission check stays synchronous and under the
10 ms budget, and you can only share what you could already do yourself.

**Placement** — a tenant's shard and tier are a row, and the resolver refuses to record a
move to a shard that has no connection configured rather than pretending a `dedicated` tier
already isolates something. This build runs one shard and says so.

## Beyond Phase 4 — the debts the build had listed

The specification stops at Phase 4. What follows is the list this README used to call "what
is deliberately not true yet", built, together with the controls the interface had claimed
and the product did not have. `pnpm loop:phase5` drives all of it end to end.

**Natural-language workflow authoring** (`/workflows`) — describe an automation in a
sentence and the compiler emits a schema-validated DAG, a plain-English readback of what it
will actually do, and the risks it found. It inserts an approval step whenever anything
could leave the company, whatever the sentence asked for: "send them a follow-up" compiles
to a draft plus an approval, and says so on the card. What it cannot build it says it cannot
build rather than guessing — a compiler that guesses produces an automation nobody can
predict. Activation is refused until a dry run of *that version* has passed; editing the
workflow closes the gate again. The dry run reads exactly what a live run would, stops
before every effect, and reports a counted number: "This would have fired 22 times in the
last 30 days. Run against today's data it matches 5 items and would have done: 5 × draft a
reply. Nothing was created, drafted or sent." The firings are history and the effects are
today's data — multiplying them would be a made-up number, so it does not. A real run hangs
off an `agent_runs` row and uses the same tools, gate, approvals, audit and undo ledger as
an agent run: there is no second execution path for effects. See ADR 0012.

**And it fires on a schedule.** Activation puts the workflow on the clock; pausing takes it
off; editing takes it off too, because an edited workflow returns to draft and a draft that
kept firing would be firing a version nobody dry-ran. Cron is evaluated in the company's
timezone a whole local day at a time, so "every weekday at 9" means nine where the company
is, and means it exactly once on the morning the clocks change — not twice, and not never.
The worker claims due schedules with `FOR UPDATE SKIP LOCKED` and advances them in the same
transaction, so two workers divide the work rather than both firing the same one. A missed
firing is a fact, not a gap: the catch-up policy decides whether a lost night fires once,
skips, or catches up to five, and whatever it drops is counted on the row and shown on the
workflow's page. Before a scheduled run starts, its unfinished runs are counted against
`max_concurrent_runs` and today's real tool calls against `daily_action_cap` — so approvals
cannot pile up while nobody decides them, and a run held back appears in the run list with
its reason. See ADR 0014.

**And you can say when, in the words people use.** The schedule editor on a workflow's page
takes the traditional aliases — `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`,
`@yearly`, `@annually` — or five cron fields. An alias is expanded on the way in, so one
grammar reaches the database however it was typed, and the same English description is shown
either way. Nothing is committed to a clock without showing the next three firings as real
dates. What cannot be honoured is refused by name with what to do instead: `@reboot` is
"whenever the process happens to start", which is not a promise about a time; `@fortnightly`
is not one of the aliases; `L`, `W` and `#` are not supported. A cron expression that would
never fire is never stored as a schedule.

**Watchers keep their own time too.** Every watcher has declared a `cadence` since the
framework was written and nothing read it — the worker ran all six every fifteen minutes,
so a watcher that says it looks for stale threads at 08:00 on weekdays was looking
ninety-six times a day, and a weekly knowledge-gap check cost the same as an hourly one.
Now the declaration is the behaviour: each watcher gets a schedule row from its own cadence,
evaluated in the organization's timezone, and only what is due runs. `/insights` shows the
six with what each looks for, when it last looked, when it looks next, and whether it has
been auto-muted for noise — an admin can re-time one, or stop it, with the same preview the
workflow editor uses. A watcher's declared cadence is a default rather than an override, so
a re-timing survives the next deploy. Muting keeps the row and says why it did not run: a
watcher that has silently stopped is indistinguishable from one that has nothing to say.
Their catch-up policy is `skip_missed` — a missed read is not worth replaying, because the
next firing sees the same world.

**Approve with edits** (`/approvals`) — the fields a tool marked editable can be corrected
in place on the card. The edited plan is then re-gated on the server: arguments re-validated,
permissions re-checked, previews re-rendered, and if the edit made the plan riskier than the
one on the card it goes back for a fresh decision rather than running on the old one. An
edit may only touch an argument the card actually offered — the recipient of an email is
deliberately not one, for the same reason retrieved content can never introduce one. The
correction is recorded as `approved_with_edits` and counted separately in the trust ledger,
because "approved after a tweak" tells you something "approved" does not. See ADR 0013.

**Admin-authored HTTP tools** (`/settings/tools`) — an organization can teach Superwork to
call one of its own systems. The tool is resolved through the same registry, checked by the
same policy engine, previewed and approved through the same approval flow, and written to
the same `tool_calls` audit trail. No exceptions: a custom tool must not be a permission
bypass. A tool cannot be activated until a named person has reviewed its host with a reason
on a recorded date, and revoking a host disables every tool that used it in the same breath.
https only; private and link-local addresses are refused; a literal credential in a header is
refused in favour of a `${SECRET}` reference; an argument the definition never declared never
reaches the request; and a tool is never advertised as reversible, because Superwork cannot
undo a change in somebody else's system. Custom tools are visible to the orchestrator only —
a sub-agent's registry is a structural guarantee, and an admin-authored tool must not be a
way to hand the Researcher a write. They are built per tenant and never registered globally,
so one organization's tool cannot appear in another's registry. See ADR 0013.

## What the product was claiming and did not have

Nine sections follow. They came out of one question — *which tables does live code read
from that nothing has ever written to?* — and each turned out to be a control the interface
described, or a code path that had been executing against an empty table for months without
ever failing.

| | The claim | What was actually there |
|---|---|---|
| [Step-up](#step-up-authentication) | "requires step-up authentication" on the governance screen | The second approver was real; step-up was not built |
| [Features](#features-and-the-switch-that-changed-nothing) | Per-organization feature flags | The resolver ran on every request against an empty table |
| [Teams](#teams-and-the-role-that-could-do-nothing) | A `team` permission scope, and a `guest` role | The scope had never evaluated true; a guest could read nothing |
| [Dependencies](#work-that-waits-for-other-work) | "your work is blocking other people" in the briefing | An `EXISTS` against a table nothing wrote to |
| [Circulation lists](#who-can-find-a-document) | Per-document access, checked in both arms of retrieval | The branch had never matched a row; sharing did not affect it |
| [Memory](#what-the-assistant-remembers) | Deleting a document removes "memories formed from it" | True only in the way an empty set makes anything true |
| [Retention](#retention-and-erasure) | Migration 0009 named "the retention and erasure jobs" | Neither job existed |
| [Legal holds](#legal-holds) | — | No way to stop the deletion once retention existed |
| [Erasure](#retention-and-erasure) | `purgeDocument` since Phase 1 | Called by nothing, so a document could not be deleted at all |

Each one below says what was wrong, what was decided, and what it cost.

## Step-up authentication

The AI-governance screen claimed from Phase 3 that publishing an agent "requires a second
approver and step-up authentication". The second approver was real. Step-up authentication
was not — the interface described a control the product did not have, which is the most
expensive kind of wrong, because somebody reads it and stops worrying.

It exists now. Before the handful of things nobody can take back — publishing an agent or
widening what it may do, rolling one back to an earlier configuration, letting a tool call a
system outside the company, adding a system tools may call, releasing the kill switch — the
person re-enters their password. What it defends against is a *session*, not a password: an
unlocked laptop, a cookie lifted from a machine, a tab left open in a shared room.

The design choices worth knowing:

- **It is not a permission, and it is not folded into `can()`.** A permission answers "may
  this person do this at all"; step-up answers "is the person who may do it still the one at
  the keyboard". Mixing them would make a synchronous, cacheable decision depend on the
  freshness of a cookie.
- **It is enforced in the repository, beside the permission check** — not at the API. A rule
  the API asks for politely is not a control.
- **Signing in is not a step-up.** They are proofs about different moments; treating one as
  the other would make the first action after login free, which is exactly the unlocked-laptop
  case.
- **It belongs to one session.** The same person in another tab has not re-authenticated
  because this one did.
- **An agent can never satisfy it**, however it was configured — it has no keyboard to be
  sitting at, and change control exists for precisely that reason.
- **A stolen session cannot become a password oracle.** Five failures lock that session out
  of stepping up for fifteen minutes. The lock is deliberately narrow: the session keeps
  everything it could already do.
- **The proof is recorded.** `audit_logs.stepped_up_at` is taken from the request context,
  never from an argument a caller could forget, and it is stamped on every row the session
  writes — a fact about the request, not a restatement of which rule applied.
- **Confirming carries out what you asked for.** The action is held, the question is asked,
  and then it runs. You press your button once.

See ADR 0015.

## Sharing one thing with one person

`share`, `unshare`, `listShares` and `sharedWith` were written for Phase 4 and reachable from
nothing but the acceptance loops — no route, no screen. Nobody could share anything, see what
had been shared with them, or revoke a share.

By the time that surfaced, two features had shipped on top of it: circulation lists union
tuples into retrieval, and the scoped task list unions shared rows into a narrow role's view.
**Both had a branch no user could populate.**

- **A share only ever adds.** One subject, one relation, one object, and nobody's role
  changes. That is the difference from a circulation list, which *narrows* who may reach a
  document, and from a team, which is a standing group. Only one of the three takes access
  away, so the panel says which.
- **You can only share what you already hold**, checked against the granter's own permission
  with the verb the relation implies. A tuple can never manufacture reach.
- **A task is shareable** — it was missing from the type while the task list already looked
  for shared tasks, so that branch could never match.
- **"Why can I see this?" is answerable**, on your own record, including the grants that
  reach you through a team or department rather than only those naming you.
- **An expired share is shown, not hidden.** It stops working the moment it lapses, and stays
  on the object's list marked as lapsed, because "they lost it on Tuesday" is the question
  being asked.

Reading the module to build the interface turned up that `sharedWith` guarded on
`member:read` — which every role holds down to `guest` — so any colleague could list what
somebody else had been given. It is self-only now, like `personalRecord` and
`listDisclosures` beside it. See ADR 0023.

### Sharing a whole project

A project had no page to put a panel on — only a list. Giving it one exposed the shape of
the problem: a project tuple opens the project and nothing on it, because the tasks inside
are separate rows with their own scope. *"I shared the project with you"* and *"you can see
none of its work"* would both have been true.

- **A container lends a read of what is inside it.** `listTasks` unions the tasks of shared
  projects into its scope predicate and `getTask` passes the task's project as its
  container, so the list and the page agree.
- **Never a say.** Not even `owner` on a project lends `update` on a task in it. The set of
  rows inside a project changes daily and the granter cannot see what they are handing over,
  so write access is granted on the row itself, where it can be seen.
- **A container you cannot open lends nothing.** A project classified above the recipient
  stayed shut while its tasks — which carry no classification of their own — opened anyway.
  The acceptance loop found that, not the test pack.
- **The project list is a permission check now**, not RLS alone. It was a raw query gated on
  `organization_id`, so a `guest` holding `project:read:team` saw every project in the
  company.
- **You can always take back what you gave.** `unshare` needed `update` on the object, so a
  member who could share a project as a viewer could not undo it. The granter can always
  revoke their own grant, and each row says whether this reader may.
- **The panel offers only the relations you could actually grant**, rather than four buttons
  of which three are refused after the form is filled in.

See ADR 0024.

### A shelf, and the account that is not one

A knowledge space was not merely unbuilt — it was impossible. A tuple names the object
`knowledge_space`; the permission catalogue spells the domain `knowledge`. Nothing
reconciled the two, so `can(actor, 'knowledge_space:read')` matched no grant any role holds:
the type was declared shareable and nobody below `owner` could share, or even read, one.

- **A shelf is a container, an account is not.** The test is whether the content has another
  home. A document lives in a space, so sharing the space lends a read of it. A company does
  not contain its threads, commitments and documents — it is a *party* to them, and each
  lives in the inbox, the ledger or the library. A company share hands over the account view
  and the panel says what it does not reach.
- **A space lends reach and nothing else.** It carries no classification of its own, so each
  document is checked against its own. Sharing the Operations shelf with a contractor opens
  the shelf and leaves every `internal` document on it shut.
- **A space share reaches retrieval**, so the assistant can cite what you were given. A
  project share does not, because a project has no relationship to the index and a space is
  what the index is organised by.
- **A list gate now considers what has been given.** All four scoped lists refused outright
  when the role held no grant — before any row was considered — so a space *given* to a
  `guest` was denied by the gate that runs before the predicate the tuple was meant to
  satisfy. ADR 0021, one level further down.
- **Indexing no longer unfiles a document.** `ingestDocument` assigned `space_id`,
  `company_id`, `project_id`, `owner_id` and `department_id` from its own input, so the seed
  filed every document into a space and the next statement set `space_id` back to `NULL`.
  The spaces table was never disconnected — the filing was erased a millisecond after it was
  written.
- **The company 360 view stopped trusting one check.** Gated once on `company:read`, it
  returned every task and document filed against the company, including ones the reader
  could not open from their own screens. A `restricted` contract listed by name is content.

See ADR 0025.

## The rules that decide what stops for a person

`approval_policies` was seeded in migration 0005 with three rules and read by nothing, while
the gate carried its own copy of one of them — `writes.length > 20`, the same twenty the
seeded row states. **The row and the constant agreed**, which is why nothing looked broken.
An admin could not see or change the rule governing them, and `policy_id` and `policy_reason`
were columns nothing filled, so an approval could not say why it was being asked.

- **A policy can only tighten.** There is no `allow` effect and there will not be one. The
  floor — any write is held for a person — lives in code and is passed into the evaluator,
  which ORs it in rather than replacing it. Switching every rule off returns to that floor.
  This is what keeps "nothing is auto-sent externally, ever, under any setting" true in the
  presence of a rule engine: no configuration reaches it, and the screen says so.
- **A deny is refused, not held.** A rule that says "forbidden" must not produce a card
  somebody can approve, so the plan's writes are struck out with the rule's name as the
  reason.
- **A rule that matches on nothing is inert**, not universal, and writing one is refused —
  as is naming a tool that does not exist. A rule that silently matches nothing reads as
  protection.
- **A policy that names a role routes by it.** `approver_user_id` defaulted to the
  requester, so "external mail needs a manager" became "the member who asked may approve it".
- **A manager can now decide an approval at all.** An approval carries no department, so
  `approval:decide:department` — the only decide grant below admin — could never be
  satisfied.
- **Self-approval means a person clearing their own request**, not a person deciding what
  their agent proposed. The old rule bound `member` alone, so an owner could self-approve
  anything.
- **An approval is not readable by everyone.** Both read paths took an actor and ignored it,
  and a preview *is* the draft: recipients, subject lines, bodies, amounts.

**Settings → Approvals**, behind step-up in both directions. See ADR 0026.

## Who is answerable, and what that is allowed to mean

`reporting_relationships` was seeded with a real org chart in migration 0001 — eleven lines
including one dotted — and read by nothing. Three controls sat on top of it, all hollow:
the ladder's fifth rung declares `audience: 'manager'` and **every rung was delivered to the
owner**, carrying a message written in the third person about them; `noSurprisesReviewHours`
was defined on every profile, quoted in the compliance review's evidence, and enforced
nowhere; and the review counted stage-5 nudges as escalations that had reached a manager,
which none of them had.

This is the point at which a work product becomes a surveillance product, so the decision is
as much about what is refused as what is built.

- **A reporting line routes accountability to a person.** It decides who an overdue item
  escalates to after the person has been asked themselves, and who may be asked to decide
  what they proposed. **It is not a window onto anybody** — there is no view of a report's
  activity, no rollup, no metric, and no setting that adds one. The screen where somebody
  would look for that says so instead of having it.
- **Every escalation is disclosed to its subject**, in the same transaction as the delivery.
  "Nothing reaches your manager that you have not seen" is a claim until it is evidenced,
  and the compliance review now fails if an escalation exists without a disclosure.
- **A rung with nobody to address is not sent to the owner as a fallback.** No manager
  recorded means no escalation, and the screen lists who that applies to rather than letting
  the ladder quietly stop.
- **One functional manager**, enforced by a partial unique index; dotted lines are context
  and are never walked for routing.
- **A loop is refused by the database**, because the thing that eventually writes one is a
  directory sync, not somebody clicking a button.
- **A line is closed, not deleted** — "who did they report to in March" is a question an
  audit asks.
- **An approval goes to the person answerable**, closing the gap ADR 0026 named: a policy
  saying `manager` meant "anybody senior enough".

**Settings → Reporting lines**, and your own line on your own record. See ADR 0027.

## Who changed the rules, and why

`jurisdiction_changes` had a writer since migration 0012 and no reader anywhere. "Who
loosened this profile, when, why, and who approved it" is the first question a compliance
review asks, and the answer sat in a table nothing selected from. The missing reader was the
smaller hole: **the history recorded only what `setJurisdiction` did**, so a sync, a
migration or a script changing the column directly left no trace — and the phase 5
acceptance loop had been doing exactly that since the previous increment.

- **The database writes the history.** A trigger records every change to a profile or a
  consultation in the same statement that makes it. No code path can move either without
  producing a row, because the row is not a separate call that can be forgotten.
- **The reason is stated on the transaction**, through a setting the trigger reads, exactly
  as row-level security reads `app.current_org` — and it is transaction-scoped, so one
  caller's justification cannot leak onto the next one's change.
- **An unexplained change is recorded, not refused.** A trigger that blocks the `UPDATE`
  gets worked around by the next migration; a change arriving without a reason lands marked
  unexplained and the review fails on it.
- **Consultation is history too.** Under a works-council profile, moving to or away from
  `agreed` switches §29 features on and off, and it was recorded nowhere.
- **Loosening is computed at read time**, so adding a profile later cannot leave old rows
  classified by a stale rule.

The first thing the record caught was the acceptance loop itself. It now goes through
`setJurisdiction` with a reason and a named approver — a better demonstration than the
bypass was. **Settings → Jurisdiction and review.** See ADR 0028.

## Adding a person to the organization

`invitations` was created in migration 0001 and never read *or* written, which made this the
largest single gap in the product: **there was no way to add somebody to an organization**
except by running the seed or connecting a directory sync.

- **An invitation is a credential**, so the token is random, stored as a hash, and returned
  exactly once. There is no screen that can show it again because the database does not have
  it, and the panel says so rather than letting somebody find out tomorrow.
- **Nothing is emailed.** No provider here calls out of the process, so claiming a message
  was sent would be the fake integration button §25 forbids. The link is handed over with
  whose job it is to deliver it written next to it.
- **You cannot invite somebody above your own role.** The membership form of "you can only
  share what you already hold" — and `owner` is absent from the API's enum entirely, because
  an organization gets its owner when it is created.
- **A bad token, a used one and a lapsed one say the same nothing.** Telling them apart tells
  somebody probing which addresses were invited.
- **One live invitation per address**, by partial unique index; accepting claims the row
  before it creates the membership, so two tabs cannot both win.
- **A withdrawn invitation is kept**, because "who invited that contractor and who called it
  off" is a question an access review asks. **Accepting signs them in** — an invitation that
  ends at a login form makes somebody type their new password twice.

Two defects came out of the same root: the unique index on `users` is
`lower(email) WHERE deleted_at IS NULL`, so `ON CONFLICT (email)` matches no constraint and
raises — and `applyDirectorySync` had exactly that, which means **re-syncing a directory threw
whenever a person already existed**.

**Settings → Members**, and `/invite/<token>` for the other half. See ADR 0029.

## What the company pays for, and what that limits

The plan was stated in three places, agreeing by luck. `plan_limits` was seeded and read by
nothing — while the config module's own comment said *"the database is the source of truth
at runtime so limits can be changed without a deploy"*, and `checkSpendLimits` read the
compile-time constant, so a limit could not be changed without a deploy. `subscriptions`
held a tier, a seat count and a spend cap that nothing consulted. And
`organizations.plan_tier` was the one the runtime used, with nothing keeping it in step.

The sharpest consequence was a refusal: on hitting the cap the agent stops and says *"an
admin can raise the cap in Settings → Billing"* — **and there was no such control on that
screen**. A refusal that names a setting which does not exist turns a working stop into a
bug report.

- **One resolved answer, from the database**, with a missing plan row falling back to the
  built-in defaults rather than to *no limit* — and the screen states which it used.
- **An organization may tighten, never widen.** A limit a tenant can raise on its own is not
  a limit. Same rule as an approval policy, for the same reason.
- **Changing the plan is not a setting.** No self-serve tier control, because what a company
  pays for is a commercial agreement, and a button that appeared to change it would be a
  fake integration.
- **The tenant cannot rewrite the plans themselves** — `plan_limits` is not a tenant table
  and the application role has no write grant on it. That was already true; it is now
  asserted, because it is what makes the tightening rule mean anything.
- **The database keeps the two tiers in step**, rather than trusting application code to
  remember that two columns must agree.
- **Seats are enforced where they are consumed**, and an outstanding invitation holds one.
  The refusal does the arithmetic.

**Settings → Usage and cost.** See ADR 0030.

## What people said when they threw an insight away

The card has asked *why* since Phase 3 — not useful, wrong, already handled, not my job —
and written the answer to `insight_feedback`, under a comment saying the reasons *"tune
future thresholds per organization and per user"*. Nothing read the table. Being asked a
question implies the answer matters.

What was read instead was the raw dismissal rate: above 70% over twenty insights, a watcher
was switched off. That treats four different sentences as one. **"You were wrong" and "you
were right and I had already dealt with it" are opposite verdicts**, and muting on the
second switches off something that works — invisibly, because a muted watcher looks exactly
like a quiet one.

- **Only *wrong* and *not useful* count against a watcher.** Above 70% of twenty ratings it
  stops running, and the row says the arithmetic.
- ***Already handled* reads as late, not bad** — the answer is to run it earlier.
- ***Not my job* reads as misrouted** — it is right, and reaching the wrong people.
- **Below twenty ratings nothing is decided from what people said.** A rate from three votes
  is a guess with a percentage sign on it, and the old dismissal rule still applies
  underneath so a watcher thrown away repeatedly with nothing said is still muted.
- **One vote per person per insight.** Otherwise one person can mute a watcher alone.
- **Rating needs `insight:read`; dismissing needs `insight:update`** — and both are checked
  before anything is written. The route had no permission check at all: a `guest` could rate
  any insight and dismiss it for everybody.

**Insights → each watcher's row.** See ADR 0031.

## Who is on a project

`project_members` has existed since migration 0002, written by the seed alone and read by
nothing. Being on a project was a row in a table: it granted nothing, appeared nowhere, and
could not be changed — while the page answered *"who is doing this?"* with one chip naming
the owner and a list of who it had been **shared** with. Those are different questions, and
the product could only express the second: the only way to give somebody access to a project
they were actually working on was to record them as an outsider being shown it.

- **Being on a project lends a read of it and of the work inside it** — up to the reader's
  own clearance, and never a say over either. The same rule a container share follows, for
  the same reason: the set of tasks changes daily, so whoever staffs it cannot see what they
  are handing over.
- **A roster is not a share, and the product never says it is.** The allow-reason reads
  *"you are on this project"*, and the person's own record lists the projects they are on
  beside the things they have been shared.
- **Who owns a project is a property of the project.** `projects.owner_id` is the fact and
  the roster's owner row is derived from it by the database; handing a project over moves
  the owner row and leaves the previous owner on the work as a contributor.
- **Staffing needs a say over the project**, not over the company's org structure.

**Any project → "Who is on it".** See ADR 0032.

## Reminders, and what an answer does

The nudge ladder (§29.2) had five rungs, a per-person daily budget shared across every
agent, an audience per rung and a manager escalation a co-determined jurisdiction switches
off. All of it existed and none of it had ever happened outside the acceptance loops.

- **Nothing opened a ladder.** `scheduleLadder` was called by the loops and by nothing in the
  product, so the worker's delivery pass ran on an empty queue every tick.
- **Nothing could receive one.** Rungs four and five are declared `in_app` and there was no
  in-app anything; every delivery wrote a `notifications` row that only retention and erasure
  ever read — both to delete it. With no chat integration connected, which is the default,
  delivery degrades to `in_app`, so every reminder would have landed nowhere and been
  recorded as delivered.
- **The answer meant nothing.** Five actions under a comment saying *"One action closes it"*
  wrote the word to a row: the task was untouched and the due query does not filter on
  `responded_at`, so you could answer "done" three times and still be escalated to your
  manager.

Now the worker opens ladders for work that is near its date, reminders arrive on a screen of
the person's own, and each answer does what it says — done completes the task, blocked marks
it with the reason given, a new date moves it and re-lays the ladder against the date the
person chose, somebody else reassigns it and sends the chasing after the work. Answering
calls off the remaining rungs; only "not yet" leaves them running, and says so.

**Nobody but you can read your reminders** — not an admin, not your manager. A list of what
somebody has been chased about is a record of that person (§29.5). A manager's escalation
arrives as their own reminder about one overdue thing, which is the difference between
accountability and monitoring.

**Reminders.** See ADR 0033.

## Comments, and follow-ups that come back

Two tables the agent wrote and nobody could read, both under a tool description promising
something the product did not do.

`comment_on_task@v1` says its comment is *"attributed to the agent by name. Never post as if
a person wrote it."* Nothing read `task_comments`, so those notes were invisible — and no
person could add one, because the only writer was a tool. The `mentions` array had been on
the row since the first migration and was never populated.

`create_follow_up@v1` says it records a follow-up *"so it resurfaces if no reply arrives."*
It never resurfaced: nothing read the table and no worker swept it, so every follow-up the
agent had recorded since Phase 2 was still open.

- **Comments are a thread on the task**, the agent's marked as the agent's. Commenting needs
  only a read of the task — discussing work you can see is not changing it. Your own words
  are yours to remove; anybody else's needs a say over the task.
- **A mention is an address**, so a trigger refuses one naming somebody outside the
  organization, and it lands on their reminders rather than in their email.
- **A follow-up closes itself when the customer writes back**, recorded as `replied` rather
  than as somebody's decision — being chased about a thread that has already been answered is
  how people learn to ignore a product.
- **What is left tells its owner once**, made structural by a unique index rather than a flag.
- **Nothing is sent outward.** A follow-up surfacing is internal; replying is still a person's
  act (§25.7), and the acceptance loop asserts the outbox is empty afterwards.

**Any task → Comments; any thread → Follow-ups.** See ADR 0034.

## The two ceilings, and who may move them

`monitoring_policies` decides how hard this system may chase the people who work here.
`agent_permissions` decides what any agent may do at all. Both were displayed and neither
could be changed without editing the database — while the agent's own refusal said *"An
admin can add it in Settings → AI governance"*, a screen that listed the grants and had no
control on it.

- **Tighten only.** Fewer contacts a day, a longer window to answer. Asking for more than the
  jurisdiction allows is refused with the number that stopped it, never silently clamped.
- **The window is now enforced.** It was displayed from the organization's row and enforced
  from the jurisdiction constant, so a company that gave its people longer saw its own number
  and had the shorter one applied.
- **Deny beats allow**, and bites even when no allow rows exist. `asAgent` filtered for
  `allow` and dropped the rest, so a deny row had never denied anything.
- **The clearance ceiling is the lowest line that applies.** `max_sensitivity` sat on every
  grant and was read by nothing.
- **Changing what agents may do asks for the password again.** Tightening the monitoring
  policy does not — that direction only protects somebody.
- **The prohibited five are a constraint, not a switch**: individual scoring, keystroke and
  screen capture, covert monitoring, automated employment decisions, reading private
  messages. The screen says so, and the test asserts the constraint rather than the sentence.

**Settings → AI governance.** See ADR 0035.

## Departments, milestones and shelves

Three tables read all over the product and written by the seed alone: `departments` — one of
the four permission scopes, and the thing the queue's fair share and every agent grant are
scoped by; `milestones`, on every project page and a quarter of the health score; and
`knowledge_spaces`, which ADR 0025 named as *"read, shared and filed into; not yet
authored"*.

- **The department tree's shape is the database's.** `path` and `depth` are derived from the
  parent, and a rename or a move rewrites every descendant. A parent in another organization
  is refused, and so is a move that would put a department underneath itself.
- **Archiving refuses while anything is still inside**, and says what — people,
  sub-departments, tasks, projects.
- **A milestone is a promise the project makes**, so it needs a say over the project.
  `completed_at` moves with the status, and the database refuses a `done` row without one.
- **A shelf cannot default its documents above what its maker may read**, and a
  department-scoped shelf is a departmental act.

This also found a real bug: milestone lateness compared `due_on` against
`startOfDay(now, tz)::date`, which in a UTC session lands on **yesterday** anywhere ahead of
UTC — so a milestone due yesterday read as not yet late, everywhere in Europe. There is now a
`calendarDate(timezone)` helper, and both readers use it.

**Settings → Teams; any project; Knowledge.** See ADR 0036.

## A question you can keep, and work you can follow

The last two tables nothing had ever touched. `saved_views` meant the tasks list offered five
fixed filters and a search box that every person retyped their own question into every day.
`task_watchers` meant the only person a task ever told anything to was its assignee — so the
manager who asked for the work and the colleague waiting on it both had to go and look.

- **The query is whitelisted on read, not only on write.** `saved_views.query` is a `jsonb`
  blob a list screen would otherwise trust. Only the keys the lists accept survive, every time
  a row is read — the row can be changed by a restore or a support script between the day it
  is saved and the day it is pressed.
- **A saved view is a question, not a share.** Applying one runs the same scope-aware read as
  the screen it belongs to, so two people opening the same shared view can see different rows.
  It stays its maker's to change or remove.
- **A watch grants nothing**, and **the fan-out re-checks at delivery**: every message is
  written only after `can()` says that person could open the task *now*, so a watch that
  outlives the access it was made under goes quiet instead of leaking. Both ends of a watch
  must be in one organization, which a trigger enforces rather than the callers.
- **Only your own watch.** There is no user id in the API — choosing what a colleague is told
  about, and learning what they are told, is the shape §29.5 prohibits. Unfollowing still
  works on a task you can no longer open.
- **Four changes are worth a message** — status, assignee, due date, title. A description
  tidy-up is not, because a subscription that fires on every edit is one people turn off.

This also found that the phase-5 loop was not repeatable: its follow-up beat turned the demo's
one outbound thread inbound and never put it back, so a *second* run on the same database had
nothing to chase. Running the loop twice is what surfaced it.

**Tasks; any task; Inbox.** See ADR 0037.

## Indexing that survives the request that asked for it

`ingestion_jobs` was created in migration 0004 with `attempts`, `last_error`,
`chunks_written` and a `verification` jsonb, and nothing ever wrote a row. Indexing ran inline
inside the caller's transaction, which hid three things:

- **A failed upload left nothing.** `ingestDocument` marks the document failed and rethrows;
  the rethrow aborts the enclosing transaction, so the document row and the failure record
  roll back together. Nothing to retry, nothing to count, nothing on a screen.
- **There was no re-index path at all** — not a button, not an API, not a tool.
- **The verification result was thrown away.** The §7.1 *Verify* stage does run on every
  ingest; its warnings were flattened into `documents.index_error`, a column that also holds
  failure messages, so "indexed, but two sections are hard to find" and "did not index" read
  identically.

Now:

- **The queue is the history of every ingestion**, not only of the retries. An upload still
  indexes inline — a document that is not indexed is not memory — but the attempt leaves a
  row saying when, how many sections, and what the check found.
- **A failure is retried on a widening delay, then stops out loud.** Five attempts, then it
  gives up, writes to the activity feed and appears on the knowledge screen as somebody's
  decision. Same reasoning as the outbox's dead-letter terminus.
- **Each job runs in its own transaction and its failure is recorded in a further one** — a
  database error aborts the transaction it happened in, so writing the failure on the same
  connection would fail silently and leave the job `processing` for ever.
- **The lifecycle is a CHECK constraint, not a convention**: `failed` is either coming back or
  has given up, never both and never neither.
- **Re-indexing needs a say over the document**, because it writes a new version and
  supersedes the old passages. **A job that gave up is woken, not replaced**, so the count it
  gave up on stays next to the person who decided to try again.

**Knowledge; any document.** See ADR 0038.

## A day somebody does not work

`departments.holiday_calendar` has existed since migration 0001 and nothing ever wrote to it
or read it. §29 spends its length on how *hard* the system may chase somebody — a per-person
daily budget shared across every agent, a jurisdiction ceiling that cannot be raised by
configuration — and said nothing about *when*. So the ladder chased people on Saturdays and on
Christmas Day.

- **The dates are computed, not fetched.** Easter by the anonymous Gregorian algorithm;
  England and Wales bank holidays including the substitute weekdays that appear when Christmas
  falls at a weekend; US federal holidays and the weekday each is observed on. A real holiday
  feed belongs behind a provider interface; this is its fallback, not a placeholder for it.
- **A calendar is a department fact, and it is inherited** from the nearest ancestor that sets
  one, so a company says "England and Wales" once instead of on every department.
- **Two gates, and the second is the guarantee.** Scheduling moves a rung onto the next
  working day; delivery checks again at the moment of sending, so a reminder scheduled before
  the calendar was set is still not delivered on a day its recipient does not work. It waits,
  and `held_reason` records why.
- **An unset calendar means the behaviour that was there before.** This may only ever reduce
  chasing, so its absence has to mean the old behaviour rather than a default nobody chose.
- **The gate is on the recipient**, not the subject — on the escalation rungs those are
  different people.

This also found that the acceptance loops were date-dependent: they asserted a reminder is
delivered and then delivered it "now". Running them on a Saturday was asserting a weekday, and
nothing showed it until the product learned what a weekend is.

**Settings → Teams; Reminders.** See ADR 0039.

## One writer for what the model cost

`agent_messages` was created in migration 0003 and nothing ever wrote a row. Cost was a
running total on `agent_runs`, so the AI ledger could say a run cost four cents and not which
step, which model, or how long any of it took.

Fixing that turned up something worse: there were already **two** writers of model spend and
they had drifted.

- `addUsage` incremented the run's totals and `recordUsageRecord` wrote the metering row, side
  by side at *most* call sites — three of four in the nervous system, and the act path's
  narrative call had no metering row at all, so that spend never reached the cap it counted
  against.
- Both run paths **also** wrote a `unit = 'agent_run'` usage record carrying the run's whole
  cost, on top of the per-call rows. `spendSnapshot` sums every unit, so an ask run was counted
  roughly twice: month-to-date AI spend was inflated and the §19.2 cap tripped at about half
  the real figure.

Now:

- **One writer.** `recordMessage` writes the message row and the metering row from the same
  numbers in the same transaction. No call site can remember one and forget the other.
- **The run's totals belong to the database** — recomputed from its messages by a trigger, so
  a corrected or deleted message leaves the total right rather than drifted.
- **A run-level usage record counts the run, not its cost again.**
- **The detail does not age out separately from the total**: messages go when their run goes,
  because purging them alone would recompute the run's cost to zero.

The run page gains a table of model calls; the ledger gains "Where the spend went", by model
and task class, read from the same rows the totals are summed from.

**Activity → any run; Analytics.** See ADR 0040.

## Work that comes back

`tasks.recurrence_rule` has existed since migration 0002 and nothing ever wrote to it or read
it, so every recurring obligation was retyped each time or forgotten. The seed's own task list
was full of them, sitting there as one-offs.

- **The grammar is the one the product already has** — the same timezone-aware cron the
  workflow schedules use, read back by the same describer and refusing the same things in the
  same words (`@reboot` is not a schedule).
- **One open occurrence at a time**, held by a partial unique index rather than by the code
  that creates the next one, so a double completion cannot produce two.
- **Finishing one makes the next, and cancelling counts as finishing** — "nothing to file this
  week" is not "stop filing". Ending the series is a separate act, and the occurrences already
  made stay.
- **Counted from the later of the occurrence's date and now**, so a task completed three weeks
  late does not produce a next one that is already overdue.
- **The rule moves to the open occurrence**, so a finished task cannot be used to stop a repeat.
- **A due date is a promise, not a delivery.** When the next one lands on a non-working day the
  date is left alone and the screen says so — the chasing already respects the calendar
  (ADR 0039).

`set_task_recurrence@v1` joins the tool catalogue, with a `preview()` that reads the schedule
back in English before anything is written.

The migration backfills before it constrains. Nothing ever wrote to the column, but rolling
this back drops the series and leaves the rules — so re-applying meets rows with a rule and no
series. Verifying apply → rollback → re-apply on an empty schema misses that; CI does it over
the seeded database, and caught it.

**Tasks; any task.** See ADR 0041.

## When a document stopped being true

`documents.effective_to` and `document_chunks.effective_to` have existed since migration 0004
and nothing ever wrote to them or read them, while `effective_from` was carried into every
passage and stated in the header the model reads.

Retrieval already filters out a **superseded version** (§7.3) — something replaced it. It had no
notion of a document that **nothing replaced and whose term simply ran out**: a rate card for a
calendar year, a fixed-term agreement, a policy valid until review. `is_superseded` stays false,
so the passage was retrieved, ranked and cited as current indefinitely. An expired clause quoted
with a citation is worse than no answer, because it looks like an answer.

- **Expired is not deleted.** The passage stays findable and stops being authoritative — an
  invoice query needs last year's prices.
- **Expiry is decided at read time, never baked into a passage.** The header carries the dates,
  because a date stays true; "this has expired" is a claim about today and a header is written
  once at ingest.
- **The judgement is stated where the model can see it**, in the product-authored grounding
  label rather than by editing retrieved text. Down-ranking makes an expired passage unlikely
  to arrive; it cannot make it impossible.
- **Expired and superseded weigh the same and multiply.**
- **A chunk's dates are its document's**, by trigger — the passage cannot go on claiming a term
  the document has changed.
- **Superseding something closes it**: the trigger derives the end date from when the
  replacement takes effect, and only ever fills a blank.
- **The header carries no dates, because it is embedded.** Putting the term in the vector
  diluted it and cost recall — the `golden.supersession` eval caught it. So changing a term
  needs no re-index at all.

**Knowledge; any document.** See ADR 0042.

## A password is not the only thing that opens the door

`users.mfa_enabled` has existed since migration 0001 and nothing ever wrote to it or read it.
Worse than the missing feature was what it left in place: **step-up — the gate in front of every
irreversible action — re-asked for the same password the session was opened with.** Its own
comment says it defends against a session rather than a password, a laptop left open or a cookie
lifted from a machine; against exactly those, the password again defends very little.

- **TOTP, verified in-process** (RFC 6238, checked against the published test vectors). The
  product still runs with no credentials and no network. WebAuthn belongs behind an
  `IdentityProvider` when one exists — it needs a browser ceremony that cannot be honestly
  simulated.
- **Enrolment is two steps, and a CHECK constraint enforces it.** A secret turns nothing on; a
  proved code does. No writer can produce an account that demands a code nobody can supply,
  because a lockout is worse than the risk.
- **Step-up asks for the factor, not the password**, once somebody has one. Otherwise the factor
  guards signing in and not the dangerous actions, which is the wrong way round — and that is the
  reason to build it at all.
- **The half-authenticated session is a row**: `mfa_satisfied_at` null resolves to nothing — no
  screen, no API, no actor — and one narrow read can see only whose code to ask for.
- **The lockout is the session's, not the account's**, so nobody can lock the real person out.
- **A used code cannot be reused inside its own window**, which is what makes each one
  single-use without a cache.
- **Recovery codes are shown once and stored as hashes**, removed as they are used.
- **Turning it off asks for the factor**, and a factor is the person's own — no administrator can
  enrol, read or remove somebody else's.

Deliberately not built: an organization-wide requirement. What happens to somebody who has not
enrolled is a decision about a business rather than a detail to guess at, and the ADR says so.

**Your own record.** See ADR 0043.

## Who decided this was confidential

`documents.sensitivity_source` has existed since migration 0004 with a default of `auto` and
nothing ever wrote another value. It could not: there was no way in the product for a person to
change a document's classification at all. So every classification was a regex's opinion,
recorded as though nobody had one — a false positive on `restricted` put a document out of reach
of the people who needed it, and there was no fix short of editing the database.

- **A classification is either read or decided, and the row says which.** A human one names the
  person, the moment and the reason, and a CHECK constraint refuses one that does not.
- **What the classifier read is kept either way.** Recording only the outcome would resolve the
  disagreement and hide it; the disagreement is the thing an auditor needs to see.
- **The classifier does not argue with the person afterwards.** It can only ever raise, so
  without this the next re-index would put a correction straight back — which is the reason the
  feature is worth building rather than an addendum to it.
- **Lowering asks for a fresh proof; raising never does.** Lowering widens who can retrieve it,
  and the measure is against what the classifier read rather than the current level, so nobody
  can descend a rung at a time without ever being asked.
- **Nobody can file a document above their own ceiling** — a classification whose author cannot
  open the document afterwards is one nobody can check.
- **The decision reaches every passage, by trigger.** The chunk is what retrieval filters on.
- **Handing it back to the classifier is the only undo**, and it restores what the classifier
  read. There is no way to leave a level in place with its author erased.

Two things in the re-index path came out of building it, and the acceptance loop found them
rather than a reading did. A re-index floored the classifier with **the level in force**, so a
person's decision would come back recorded as the pattern's own reading; and it did not restate
the document's **term**, so re-indexing an expired contract silently returned every passage of
it to circulation as current — the one thing ADR 0042 exists to stop. Both are fixed with the
tests that fail without them.

**Knowledge; any document.** See ADR 0044.

## A grant nobody could satisfy

`ROLE_PERMISSIONS.member` has included `document:create:own` since Phase 0, and no member has
ever been able to add a document. `own` is satisfied by the resource being the actor's, and
`uploadDocument` asked about a document that did not exist yet without saying who would own it —
so the check refused every member with *"You need Member access to create this document"*, said
to a member, pointing at a settings screen where nothing could be changed to fix it. The button
was offered to viewers too, so the refusal arrived after somebody had typed the whole thing.

- **A create is asked about the resource that is about to exist.** The owner in the check is the
  owner in the `INSERT` — the same value in both places, rather than a check about nothing. The
  agent runtime already did this; the document path did not.
- **`document:update:own` was dead by consequence**, because nobody could own a document they
  had added. A member's document is now theirs to reclassify and put a term on.
- **A document you could not open a moment later is refused before anything is stored.** The
  classifier is a pure function of the content, so what ingest will decide is knowable before
  the first `INSERT`: a member filing compensation content would have indexed it, been refused
  on the read-back, and been left with an error and a document they could not see or remove.
  The refusal says what it read, what the ceiling is, that nothing was stored, and who can file
  it instead.
- **A transcript is not refused the same way** — it is the record of a meeting somebody
  attended, and losing it over a word said in the room is not a trade worth making.
- **The screen asks the same question the server answers**, so the button is disabled with the
  policy engine's own sentence and the ceiling is stated before anybody types.

**Knowledge; add a document.** See ADR 0045.

## A throttle somebody set

`workflows.max_concurrent_runs` and `daily_action_cap` have existed since migration 0007 and
nothing ever wrote either. Unlike most of what this work has found, they were never
decorative: both are read on every firing and **both are enforced**. Every workflow in every
organization ran on the column defaults — 1 and 100 — chosen by a migration for nobody in
particular. The skip message says *"Raise the cap if that is too low — it is a number somebody
set, not a failure."* Nobody set it, and nobody could raise it.

- **Both numbers are settable together, with a reason**, because they are one decision: how
  hard this automation may run.
- **Raising asks for a fresh proof; lowering never does.** Raising widens what runs with
  nobody watching, and the actions have happened by the time anybody reviews them.
- **There is no "unlimited"** — 1–50 runs at once, 1–10,000 actions a day, refused in the
  repository with the numbers in the message and again by a CHECK constraint.
- **A number somebody chose names them and says why**; a workflow still on the defaults names
  nobody, and the panel says exactly that. An unattributed default and a deliberate choice of
  the same number are different facts.
- **The counting moved into the repository.** The screen that offers to change a limit shows
  what the limit is doing right now, from the same function the scheduler calls — two places
  counting "what has it done today" would eventually disagree about the only thing that
  matters.

Admins and owners set it, not the workflow's own owner: the throttle is the ceiling on what
activation means, so it sits with the people who set the other ceilings (ADR 0035).

**Workflows; any automation.** See ADR 0046.

## When you are written to

`notification_preferences` has held three columns since migration 0010 that nothing honoured.
`quiet_hours` defaulted to 18:30–08:30 for everybody and was consulted by no code path at all, so
a mention at half past eleven at night arrived immediately and the reminder ladder — which knows
about weekends and public holidays — knew nothing about the evening. `channel_defaults` and
`per_type` are the shape of "which of these can wait for the morning", and every notification was
written by a hand-rolled `INSERT` with its delivery hard-coded at one of **seven** call sites.

- **One writer.** `notify()` is the only way a notification is created. Routing is a fact about
  the recipient, not a decision for whichever subsystem happens to be writing.
- **Quiet hours hold; they never drop.** The row is written when the thing happens and becomes
  visible when the window opens, through `deliver_after` — on the table since 0005 and written by
  nothing. No sweep releases anything, so a stopped worker cannot hide a notification.
- **The window is the recipient's, in the recipient's timezone**, and its end is computed from
  wall-clock parts so it survives the morning the clocks change.
- **A window may not cover the day** — sixteen hours is the ceiling, refused with the number that
  stopped it and again by a CHECK constraint. "Never write to me" is not on offer; turning
  individual kinds down is.
- **Three deliveries, none of them "lost".** Immediate interrupts; digest arrives in the daily
  briefing, which gained the section that makes that mean something; nothing is still recorded
  and findable.
- **Two kinds cannot be turned down**: the notice that something about you reached somebody else,
  and the assistant stopping to ask you a question. A guarantee you can switch off is not one.
- **And that disclosure is now actually sent** — it used to be recorded on the subject's own
  record and never delivered, so the guarantee relied on them thinking to look.
- **Reminders are scheduled into the open hours and checked again at delivery**, because a window
  can change after a rung is written.
- **It is the person's own** — no administrator sets somebody else's quiet hours.

The cost is stated in the ADR: three test packs and two loops had to name the hour they meant,
because they assert that something arrives and that now depends on a window. `makeReachable` in
the fixtures says so out loud.

**Your own record; anybody's.** See ADR 0047.

## Features, and the switch that changed nothing

`feature_flag_overrides` was the last table nothing wrote to, and the odd one out: the
**read path was already finished**. The session loads it on every request, splits the
organization-wide rows from the per-user ones and layers them over `DEFAULT_FLAGS`. That has
run on every page load since Phase 0 and never found a row — so every organization had
identical features and no administrator could change one.

Three layers, shown as three layers: default → organization → person, with the screen saying
which layer a value came from and why. **A person's own choice sits on top of the
organization's** — correct for a preference, wrong for a capability, which is exactly why it
is said out loud: anything governing what a tenant *may* do belongs in the policy engine or a
plan limit, never in a switch somebody can flip for themselves.

Reading takes no permission — the session already computes these values for everybody, so
requiring one meant a member could not find out why a screen was missing. Changing the
organization layer needs `settings:update` and a reason, and is audited; a personal
preference is neither.

An unknown flag name is refused twice, by the repository with a sentence and by the database
with a `CHECK` — the resolver layers unknown keys onto an object nobody reads, so a
misspelled override would sit there for ever looking as though it did something. A test
asserts the code list and the database list agree.

**A flag that controls nothing gets no switch.** `reports`, `autopilot`, `chat_presence` and
`public_api` are read by nothing at all; they are listed on the screen as declared-but-inert,
without a toggle. A control that changes nothing is worse than an absent one. Two others were
wired rather than left that way: `insights` gates its navigation entry, and `compact_density`
sets the row height for one person — the one genuinely per-person flag, which makes the
person layer visible in the interface rather than only in a test.

**Settings → Features**. See ADR 0022.

## Teams, and the role that could do nothing

`teams` and `team_members` were created in migration 0001 and never written to. That looked
like two unused tables. It was not: the `team` scope in the policy engine had never once
evaluated true, and every permission the `guest` role holds is team-scoped —
`task:read:team`, `project:read:team`, `document:read:team`, `note:create:team`. **A guest
could read nothing at all**, and the denial said "You need Member access", which reads like a
policy rather than a missing dimension.

The scope was dead four ways over, and all four had to go:

1. no team existed;
2. no resource carried a `team_id`;
3. nothing passed `resource.teamIds` to `can()`, so the check evaluated `[].some(…)`;
4. **every list gated on an organization-level resource** — "may you read every task" — which
   is false for any role whose grant is narrower, so the query never ran.

The fourth is the one worth remembering. `grantedScope(actor, action)` returns the broadest
scope an actor holds, independent of any row, and the list turns it into a SQL predicate. A
gate taken at organization level silently reduces every narrower role to nothing, and does it
without ever failing. Relation tuples are unioned in rather than intersected, so a shared
document still reaches somebody whose scope would not.

Clearance was the fourth-and-a-half. `checkClearance` defaulted an *absent* classification to
`internal`, putting every unclassified resource above the guest ceiling of `public` — and
tasks, projects and notes have no classification column at all. It now returns early when
there is nothing to check; the blast radius is exactly the guest role, and the 376-test
policy pack passed unchanged.

A team is not a department: a department is where somebody sits and there is one per person,
a team is what they are working on and there can be several. Membership is a grant of access,
takes a reason, is audited, and takes effect on the member's next request. A team cannot be
disbanded while work is still scoped to it — those rows would keep pointing at a team nobody
can see. And `hybridSearch` applies the same team filter, so search and the detail view never
disagree.

**Settings → Teams**. See ADR 0021.

## Work that waits for other work

`task_dependencies` was created in migration 0002 and never written to, while the daily
briefing ran an `EXISTS` against it on every generation. "Your work is blocking other people"
has been structurally empty since Phase 2 — for every user, on every day, without ever
failing.

Two things were missing, one of them invisible. The only index served "what does this task
wait for"; every read in the product goes the other way, so the briefing's subquery was a
sequential scan whose emptiness was the only reason nobody noticed. And there was no cycle
check at all.

- **A cycle is refused by the database.** A trigger walks the graph and raises before the row
  lands; the repository only rewrites the message to name the two tasks. The thing that
  eventually writes a cycle is a bulk import or an agent, not somebody clicking twice — the
  same reasoning as the append-only trigger on `audit_logs`.
- **Both ends must be the same organization's**, enforced by a second trigger. RLS stops one
  tenant reading another's rows, but the foreign keys point at `tasks(id)` with no tenant in
  them, so nothing stopped a row *referencing* across the boundary.
- **Completing a task past an unfinished prerequisite is refused**, naming it and its
  assignee. This is what makes the record a dependency rather than a note. A cancelled
  prerequisite counts as finished.
- **Finishing a task tells the people it was holding up** — and only those whose *last*
  prerequisite it was, because telling somebody they are unblocked when they are not trains
  them to ignore the message. Nobody is told about their own completion.
- **Permission is checked on the dependent task**, not the prerequisite. Saying "my task waits
  for yours" is a statement about my work; requiring your permission would mean nobody ever
  records a dependency across a team boundary.

The list view carries `waiting on N` and `blocking N` chips, and there is a task detail page
showing both directions — the notification had to land somewhere. See ADR 0020.

## Who can find a document

`document_permissions` was created in migration 0004 and never written to, while being read
by the ACL predicate in **both** arms of retrieval and, since memory shipped, by recall. Its
branch had been evaluated on every search since Phase 1 and had never matched anything.

Meanwhile `share()` writes a **relation tuple**, and retrieval does not consult tuples at
all. So sharing a document left "I shared it with you" and "the assistant cannot find it"
both true, with nothing saying so. That was a live bug, not a gap.

The two mechanisms have opposite shapes, which is why both exist. A tuple is **additive** —
one subject, one relation, one object, nothing taken away. A circulation list is
**restrictive** — while any row exists for a document, only the subjects named may retrieve
it. An HR file or a signed contract needs the second, and neither can be expressed as the
other.

- **A list can only narrow.** The classification ceiling is a separate condition, ANDed, so
  naming a member on a `restricted` document does not let them retrieve it. Adding a *role*
  below the ceiling is refused outright, naming the classification as the thing to change if
  that is really what is meant, rather than storing a grant that silently does nothing.
- **Nobody is exempt, including the owner.** An administrator not on the list will not see
  the document in retrieval or cited in an answer. They can add themselves — which leaves a
  row saying they did, and that is better than a bypass nobody can audit. Opening the
  document's page is a separate question, governed by `can()`; the screen says so.
- **Sharing a restricted document adds the recipient to the list**, so the two stop
  disagreeing. On an open document it does nothing, because that is what a tuple already
  means.
- **The first grant is its own event.** It is the moment everybody else loses the document,
  so it audits differently, writes an activity entry, and the interface warns before it.
- **Reopening is never a side effect.** Removing the last name is refused; clearing the list
  is a separate control with its own reason and audit action.
- **Every row says why, and who added them.** A list that cannot explain itself is one nobody
  will ever prune.

See ADR 0019.

## What the assistant remembers

`memory_facts` had existed since migration 0006 with a complete design and no writer. Two
live paths read it — `deleteDocument` counted the memories a deletion forgets and
`purgeDocument` forgot them — so both reported zero about an empty table, and this README's
promise that deleting a document takes "any memories the assistant formed from it" was true
only in the way an empty set makes anything true.

An assistant that cannot remember re-derives the same answer from the same document every
time. An assistant that remembers badly is worse than one that does not. The design is
entirely about which of those you get:

- **Nothing is remembered without a source.** Every fact carries the passage it came from,
  enforced by a `CHECK`, so a remembered fact is a claim somebody can open and argue with.
- **The source is resolved, never taken.** A proposal names a passage *by its index into the
  run's own grounding*. A model that invents a document id cannot store one; one that cites a
  passage the run never retrieved is refused with a reason rather than kept at low confidence.
- **Nothing is recalled until a person agrees.** Candidates are what the assistant noticed;
  confirmed facts are what somebody stood behind. `confirmed_by` is NOT NULL and an agent
  actor is refused outright — the failure mode being prevented is one wrong inference quietly
  becoming the foundation of every later answer.
- **Recall is bound by the permissions of the source.** A memory is a compressed quotation, so
  it is gated by the document it quotes — the same sensitivity ceiling and
  `document_permissions` predicate the retrieval layer applies. Two people can open the memory
  screen and see different lists.
- **Two confirmed answers to one question are unstorable.** A partial unique index means
  changing what is known is necessarily a supersession: the old answer is closed off with a
  date, the new one points back at it, and who changed their mind is on the record.
- **A contradiction is surfaced, not resolved.** A candidate that disagrees with an agreed
  fact is shown beside it; confirming it directly is refused, and the refusal names the path
  that is open.
- **Forgetting is a state, not a delete**, because "we used to believe this" is a question
  somebody will ask about an answer from last month.
- **Volatile facts carry their age.** Anything with a figure or a duration in it is recalled
  with the date it was agreed, and past 90 days is marked worth checking rather than silently
  retired.

Confirmed facts are never purged by age — only forgotten and superseded ones, under a
`memories` retention class. A fact scoped to one person is deleted on erasure.

**Knowledge → What it remembers**. See ADR 0018.

## Retention and erasure

Migration 0009 made `audit_logs` append-only and, in its own header, named the exception:
history may leave only "by the retention and erasure jobs". Those jobs were never written.
`purgeDocument` — which removes a document with its chunks, embeddings, citations and derived
memories in one transaction — had existed since Phase 1 and was called by nothing, so there
was no way to delete a document at all. And nothing anywhere said how long anything was kept.

**Seven classes, each with a window.** Agent runs, tool calls, meeting transcripts,
notifications and nudges, resolved insights, the API request log, and the audit trail. A class
nobody has configured falls back to the default for the organization's jurisdiction profile,
and the screen says which — *"The default for works council. Nobody has changed it."* Every
class also has a floor in code that no configuration can go under; the audit trail's floor is
two years and its default is the longest of the seven, because the trail is what makes every
other claim here checkable.

Changing a window needs a reason of at least eight characters — a `CHECK` constraint, not form
validation — and a re-typed password, because shortening a window is destruction on a timer,
decided once and executed silently thereafter. The worker sweeps every 24 hours, in batches,
and writes back what it removed per class; the screen shows it, and "not yet run" is a
legitimate state it will admit to. A run still waiting for somebody's approval is never
purged: it is not old, it is outstanding.

The audit purge is the one statement in the product that runs on the owner connection. The
application role has `DELETE` REVOKEd and the 0009 trigger would refuse it anyway, so the
statement carries its own `organization_id` predicate — there is no RLS behind it to catch a
mistake. That is the door 0009 promised, cut once, in the open.

**Erasing a person says what it will do, in full, first.** Eleven tables, each marked
*deleted*, *anonymised* or *kept*, each with its basis:

- **Deleted** — what is only theirs and only about them: nudges, notifications, briefings,
  sessions, notification preferences.
- **Anonymised** — other people's work with their name on it: tasks, commitments, transcript
  segments, agent runs. Deleting a task because its owner left destroys work the company still
  has to do.
- **Kept, with the basis stated** — the audit trail and the disclosure log. The disclosure log
  is the record of what was said about a person to somebody else; erasing it to protect them
  would destroy their only proof that nothing was said behind their back.

Nothing is anonymised to a blank: rows point at one tombstone user, and the erasure record
itself stores *"A former member of this organization"* under a constraint that rejects
anything containing an `@`. When it completes it drops the subject's id, so the record of the
erasure is not itself a record of the person. Blockers — sole owner, or an active workflow
naming them as accountable — stop it before the button appears. Nobody can erase themselves.

**Deleting a document counts what went with it.** The warning states the passages and
citations before, the API returns what it actually removed after, and the audit row carries
both. A cascade nobody can see is indistinguishable from one that did not happen.

Both live on **Settings → Retention**, behind `owner`. See ADR 0016.

## Legal holds

Retention deletes on a schedule. This stops it. The two failures are not symmetric: keeping
data too long is a privacy cost argued about in advance and defensible with a stated basis,
while deleting what a matter required be kept is spoliation — found afterwards, and not
undone by having meant well. A product that automates the deletion and offers no way to
suspend it has automated the worse of the two.

A hold names a matter, a basis, a set of custodians and a period, and while it stands nothing
it covers is purged by a retention window, erased on request, or deleted from the library.
The refusals name the matter rather than failing quietly, because an erasure that stops
without saying why sends somebody looking for a bug instead of looking for counsel.

**It is a row the purge consults, not a flag on the records.** A flag could only ever cover
what existed the moment the hold was placed, and most of what a matter covers arrives
afterwards. One predicate is built once and used by every class; each class supplies which
timestamp the period is measured against and what makes a row attributable to a custodian —
a run belongs to its principal, an API request to the person its key acts as, an audit row to
whoever did it or whoever it was done for, and a transcript to everybody who spoke in it, so
one custodian's line holds the whole record. The timestamp is always the same column the
purge compares against its cutoff, which is what makes "held ⇒ never purged" structural
rather than something to remember.

Naming no custodians means everybody — the ordinary case when a regulator opens a file, and
it keeps covering people who join later. Leaving the end date blank means "and everything
since", because a live matter has no end date.

**Placing needs no password; releasing does.** The same asymmetry as the kill switch:
somebody has usually just been told to stop deleting, and friction there buys nothing, while
releasing is the half that cannot be taken back — the next sweep deletes what the hold was
keeping and does not ask first.

**Every named custodian is told, and it cannot be turned off.** The notice goes into the
disclosure log, where the never-covert constraint applies to it for free. A hold nobody is
told about is indefinite retention of one person's records on somebody's private say-so,
which is the thing §29.5 makes unconfigurable everywhere else here.

**The sweep says what it left alone**, per class, counted before the delete — afterwards a
held row looks identical to one that was never due. And the retention screen says a hold is
in force from the moment it exists rather than from the next sweep, because a window that
looks unenforced is a support call.

**Settings → Legal holds**, behind `owner`. See ADR 0017.

## What is deliberately not true yet

Every limit below is a decision, not an oversight. Controls for anything unbuilt render
disabled with the reason named; nothing in the interface pretends to work.

**Nothing calls out of the process.** Outbound HTTP is simulated unless a deployment sets
`HTTP_TOOLS_MODE=live`: a custom tool returns a deterministic locally-generated response
marked **Simulated**, while everything around it — review, permissions, previews, approvals,
audit — is real. Every other provider ships as a simulated implementation too, and
connecting one says so on the row.

**The scale budgets are measured below the scale they target.** The harness prints the scale
it actually reached beside the scale the target assumes, rather than rounding the difference
away. They are evidence about query shape, not a 100,000-user result.

### Where the grammar stops

- The workflow compiler understands the sentences it understands and refuses the rest. New
  shapes need a named query in the safe query layer, not a cleverer prompt.
- Cron is the five standard fields plus the traditional aliases. Nothing parses `L`, `W` or
  `#`, and a spec that does not parse is refused when the schedule is written rather than
  silently never firing. Schedules are minute-granular.
- Memory extraction is only as good as its rule: the mock brain notices a fact only when a
  cited sentence reads as a plain "X is Y" statement. Anything phrased another way is not
  noticed at all.

### Where a control is coarser than you might want

- Retention windows are per class, not per record. A single meeting cannot be pinned on its
  own; a legal hold is the coarser instrument that covers a matter, and it has no expiry —
  a hold is released by somebody deciding to, not by a clock.
- A task dependency has no type. There is one relation, "cannot be completed until", not a
  scheduling calculus.
- The task, document, project and knowledge-space lists are scope-aware. The other list
  endpoints still gate at organization level, which is right for every role above `guest`
  and wrong in the same way for `guest`.

### Where we refuse on purpose

- **No covert legal hold.** A hold notice cannot be suppressed, so the kind a fraud
  investigation would want — where telling the custodian tips them off — is not expressible
  here and has to be taken outside this product under a court order.
- **No self-service erasure.** Verifying that a request came from the person it names is a
  problem this product does not solve, and an endpoint with a weak identity check is worse
  than none.
- **Nothing is inferred.** The agent will not propose a task dependency, and will not scope
  work it creates to a team. A model inferring "this probably waits for that" and having it
  enforced at completion time is a much larger claim than recording one by hand.

### What is declared and inert

- Every shareable type now has a panel: tasks, documents, projects, knowledge spaces and
  companies. `ShareableType` and the interface finally agree.
- A container share reaches two relationships: a project's tasks and a space's documents.
  Meetings and conversations belong to companies and are deliberately not wired up — under
  the rule in ADR 0025 they never will be, because each has a home of its own.
- Sharing a project or a space adds nobody to a circulation list, so a restricted document
  stays restricted either way. For a space this is load-bearing: adding the first name to a
  document with no list *removes everybody else*, so syncing a space share across a shelf
  would silently restrict every document on it.
- Knowledge spaces are read, shared and filed into, but not authored. There is one seeded
  space and no way to create a second from the interface.
- An approval routed to a role is visible to everybody who holds it, and approvals carry no
  department — so a department-scoped decider currently sees the whole queue. Narrowing that
  needs a department on the approval, which is a schema change and a separate decision.
- `approvals.delegated_to` is still a column nothing writes. Handing an approval to a named
  person for a period is a real feature and is not the one that was built.
- Nothing walks *down* the reporting chain. There is no "my reports' overdue work" query,
  and adding one would be the §29.5 prohibition wearing a different name.
- The jurisdiction history covers a profile and a consultation, not `legal_entities.data_region`.
  Residency is an organization-level setting elsewhere, moving it is a migration rather than
  a toggle, and the entity-level column has no setter at all — left alone rather than
  half-covered.
- Deleting a legal entity cascades its history away. An entity that no longer exists has no
  history to review, which is right, and worth knowing before somebody goes looking.
- The demo organization has no legal entity, so it resolves to the strictest profile and
  escalates nothing to anybody. The escalation path is exercised only where a profile
  permits it.
- The rule form is constrained: one tool, or a number of changes, or a risk level. Rules
  combining conditions can be seeded but not written from the interface.
- `project_members` is written by the seed and read by nothing. It carries one row per
  project — the owner, who is already on the project row — so it says nothing the product
  does not already know. Sharing is the mechanism that grants project access.
- There is no organization-wide view of every share. `sharedWith` is self-only, so an access
  review is done object by object — the honest substitute until the roll-up is worth the
  permission it would need.
- Four of the ten feature flags — `reports`, `autopilot`, `chat_presence`, `public_api` —
  are read by nothing. They are listed on the Features screen as inert rather than given a
  switch, because a control that changes nothing is worse than an absent one.
- Two tables are dead schema that nothing reads *or* writes: `email_accounts` and `events`.
  They are left in place rather than dropped, and listed here so nobody has to rediscover
  them; neither has a live reader, so neither is silently affecting behaviour. `email_accounts`
  is where connecting a real mailbox would start. (`agent_messages`, `ingestion_jobs`,
  `saved_views` and `task_watchers` were on this list and have since been built — ADRs 0037,
  0038 and 0040.)
- The demo organization ships with no feature-flag overrides, because seeding one would mean
  turning a feature off in the demo.
- Only the spend caps and seats stop anything. `plan_limits.agent_runs_per_month`,
  `documents_indexed`, `storage_gb` and `workflow_runs_per_month` are resolved and displayed
  but enforced nowhere — naming that is better than four more half-checks.
- Members can be invited and listed but not edited from the Members screen. Changing a role
  or deactivating somebody still lives in Identity, with the directory sync.

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
- **An API key is a person, not a service account.** Every key has a principal, every call
  authorizes through the same `can()` as the UI, and MCP exposes read-tier tools only.
- **Nothing about a person moves without a row.** Digests, reports and exports write a
  disclosure the subject sees at the same moment the recipient does — enforced by a `CHECK`
  that makes an invisible disclosure unstorable.
- **The kill switch is real.** It halts every run in the organization, marks in-flight runs
  `aborted_by_admin`, and is two clicks from any screen for an admin. Engaging it needs
  nothing but the click — stopping the agents in a hurry is the point, and friction belongs
  on the other side. *Releasing* it asks who is there.
- **Nothing irreversible happens on a session alone.** Publishing or widening an agent,
  rolling one back, activating a custom tool, reviewing a host it may call, releasing the
  kill switch, shortening a retention window and erasing a person all require the person to
  re-enter their password within the last five minutes, and the proof is stamped on the audit
  row.
- **Deleting a document deletes what was derived from it.** The chunks, embeddings, citations
  and memories go in the same transaction, and the count of each is reported to the caller and
  written to the audit trail (§25.13). The memory count is now a real number rather than a
  fact about an empty table.
- **Sharing adds and never subtracts.** A grant is checked against what the granter already
  holds, is answerable from both the object and the person, and stops counting the moment it
  expires without being deleted.
- **A feature can be turned off for one tenant, and kept by one person.** Three layers
  resolved per request, the organization layer audited with a reason, and no switch offered
  for a flag that controls nothing.
- **A narrow role sees exactly its own slice.** Lists ask the policy engine which rows the
  actor may consider rather than whether they may read everything, so a contractor on one
  team sees that team's work and nothing else — in the list, in the detail view and in
  retrieval alike.
- **A dependency cannot be walked past.** A task with an unfinished prerequisite refuses to
  complete, a cycle is refused by a database trigger rather than by application code, and
  finishing a prerequisite notifies whoever it was the last thing blocking.
- **A document can be taken out of general circulation, and the restriction bites.** While a
  circulation list exists, only the subjects on it retrieve the document — enforced inside
  both arms of hybrid search and in memory recall, with no exemption for administrators.
- **The assistant cannot decide what the company believes.** Nothing it notices is recalled
  until a person agrees; `confirmed_by` is NOT NULL and a non-human actor is refused. Recall
  never reaches past the permissions of the document a fact was drawn from.
- **Everything kept has a stated window and a purge that runs.** Seven classes, each with a
  floor no configuration can go under, swept daily by the worker, with what it removed written
  back where anyone can see it.
- **A matter can stop the deleting, and cannot do it quietly.** A legal hold suspends the
  purge, refuses erasure and refuses document deletion for what it covers, naming the matter
  each time; every named custodian gets a disclosure they can read, and there is no setting
  that turns that off.

## The decisions, and why

One record per irreversible decision, in `docs/adr`. They are the argument, not the
changelog: each says what was chosen, what it rules out, and what it costs.

| ADR | |
|---|---|
| [0001](docs/adr/0001-postgres-as-the-single-substrate.md) | PostgreSQL is the single data substrate |
| [0002](docs/adr/0002-sql-over-orm.md) | Hand-written SQL migrations and a typed query layer, not an ORM |
| [0003](docs/adr/0003-two-database-roles.md) | Two non-superuser database roles |
| [0004](docs/adr/0004-deterministic-mock-ai.md) | Mock AI reasons over real data |
| [0005](docs/adr/0005-runs-are-durable-state-machines.md) | Agent runs are durable state machines, not in-memory promises |
| [0006](docs/adr/0006-audit-append-only-with-erasure.md) | Append-only auditing that still permits erasure |
| [0007](docs/adr/0007-a-commitment-belongs-to-the-person-who-made-it.md) | A commitment belongs to the person who made it |
| [0008](docs/adr/0008-the-ledger-counts-departments-not-people.md) | The AI ledger counts departments, never people |
| [0009](docs/adr/0009-an-api-key-acts-as-a-person.md) | An API key acts as a person, and MCP is read-only |
| [0010](docs/adr/0010-fair-share-scheduling-in-the-database.md) | Fair-share scheduling lives in the database |
| [0011](docs/adr/0011-the-strictest-jurisdiction-is-the-default.md) | The strictest jurisdiction is the default, and the review is a query |
| [0012](docs/adr/0012-a-workflow-is-a-planner-not-an-execution-path.md) | A workflow is a second planner, not a second execution path |
| [0013](docs/adr/0013-an-edit-is-a-narrower-approval.md) | An edit is a narrower approval, and a custom tool is an ordinary tool |
| [0014](docs/adr/0014-a-schedule-is-a-row-and-a-missed-firing-is-a-fact.md) | A schedule is a row, evaluated in the company's timezone, and a missed firing is a fact |
| [0015](docs/adr/0015-step-up-is-not-a-permission.md) | Step-up is not a permission |
| [0016](docs/adr/0016-deletion-is-a-feature-not-a-cron-job.md) | Deletion is a feature, not a cron job |
| [0017](docs/adr/0017-a-hold-is-a-row-the-purge-consults.md) | A hold is a row the purge consults |
| [0018](docs/adr/0018-the-assistant-notices-a-person-decides.md) | The assistant notices, a person decides |
| [0019](docs/adr/0019-a-circulation-list-narrows-a-tuple-widens.md) | A circulation list narrows, a tuple widens |
| [0020](docs/adr/0020-a-dependency-that-can-be-walked-past-is-a-comment.md) | A dependency that can be walked past is a comment |
| [0021](docs/adr/0021-a-scope-is-what-a-list-asks-about.md) | A scope is what a list asks about |
| [0022](docs/adr/0022-a-switch-that-changes-nothing.md) | A switch that changes nothing |
| [0023](docs/adr/0023-a-share-only-ever-adds.md) | A share only ever adds |
| [0024](docs/adr/0024-a-container-lends-a-read.md) | A container lends a read, never a say |
| [0025](docs/adr/0025-a-shelf-is-a-container-an-account-is-not.md) | A shelf is a container, an account is not |
| [0026](docs/adr/0026-a-policy-can-only-tighten.md) | A policy can only tighten |
| [0027](docs/adr/0027-a-reporting-line-routes-accountability-not-visibility.md) | A reporting line routes accountability, not visibility |
| [0028](docs/adr/0028-the-database-writes-the-history.md) | The database writes the history |
| [0029](docs/adr/0029-an-invitation-is-a-credential.md) | An invitation is a credential |
| [0030](docs/adr/0030-a-limit-a-tenant-can-raise-is-not-a-limit.md) | A limit a tenant can raise is not a limit |
| [0031](docs/adr/0031-a-watcher-that-is-right-and-unwelcome-is-not-one-that-is-wrong.md) | A watcher that is right and unwelcome is not one that is wrong |
| [0032](docs/adr/0032-being-on-a-project-lends-a-read-not-a-say.md) | Being on a project lends a read, not a say |
| [0033](docs/adr/0033-a-reminder-has-to-arrive-somewhere-and-the-answer-has-to-mean-something.md) | A reminder has to arrive somewhere, and the answer has to mean something |
| [0034](docs/adr/0034-a-note-nobody-can-read-is-not-a-note.md) | A note nobody can read is not a note |
| [0035](docs/adr/0035-a-ceiling-you-can-only-look-at.md) | A ceiling you can only look at |
| [0036](docs/adr/0036-the-structure-a-product-is-governed-by-should-be-buildable-in-it.md) | The structure a product is governed by should be buildable in it |
| [0037](docs/adr/0037-a-saved-view-is-a-question-and-a-watch-is-not-a-grant.md) | A saved view is a question, and a watch is not a grant |
| [0038](docs/adr/0038-indexing-has-to-survive-the-request-that-asked-for-it.md) | Indexing has to survive the request that asked for it |
| [0039](docs/adr/0039-a-day-somebody-does-not-work.md) | A day somebody does not work |
| [0040](docs/adr/0040-one-writer-for-what-the-model-cost.md) | One writer for what the model cost |
| [0041](docs/adr/0041-work-that-comes-back.md) | Work that comes back |
| [0042](docs/adr/0042-when-a-document-stopped-being-true.md) | When a document stopped being true |
| [0043](docs/adr/0043-a-password-is-not-the-only-thing-that-opens-the-door.md) | A password is not the only thing that opens the door |
| [0044](docs/adr/0044-who-decided-this-was-confidential.md) | Who decided this was confidential |
| [0045](docs/adr/0045-a-grant-nobody-could-satisfy.md) | A grant nobody could satisfy |
| [0046](docs/adr/0046-a-throttle-somebody-set.md) | A throttle somebody set |
| [0047](docs/adr/0047-when-you-are-written-to.md) | When you are written to |

## Configuration

Every variable is validated at boot with Zod and the process refuses to start on a bad
config. A web deployment whose environment is incomplete serves one page naming every
variable that is missing or invalid, on every route, rather than an exception digest —
the whole list at once, so configuring it is not one redeploy per problem.
`vercel.json` points the platform at the workspace build (`pnpm --filter
@superwork/web build` → `apps/web/.next`), and `next` is a root devDependency so the
framework detector finds it when the project's Root Directory is the repository root —
set Root Directory to `apps/web` instead and neither is needed; a hosted deployment still needs `DATABASE_URL`
pointing at a PostgreSQL 16 instance with `pgvector` and `pg_trgm`, `SESSION_SECRET`, and
the migrations applied — the app boots against an empty database but every screen is a
sign-in wall until `pnpm db:seed` or a real organization exists. `AI_MODE`, `EMAIL_MODE`, `CALENDAR_MODE`, `STORAGE_MODE` and `BILLING_MODE` each
resolve to `mock | sandbox | live`, and the resolved mode is rendered in the interface
wherever it affects what you should believe. `AUTOPILOT_ENABLED` is rejected while
`AI_MODE=mock`.

The request path connects as `superwork_app` or `superwork_auth` and never as the table
owner, which would bypass RLS. Both URLs are derived from `DATABASE_URL` by replacing the
username, so by default all three roles share one password; `DATABASE_APP_URL` and
`DATABASE_AUTH_URL` name them separately where that does not hold, which is the usual case
on a hosted database. Each must still connect as the role it names — an override pointed at
the owner is refused at boot.

## Deployment

**[docs/deployment.md](docs/deployment.md) is the full sequence**: database, extensions,
migrations, the three roles and their passwords, the variables, and what each failure
means. The rest of this section is why the repository root looks the way it does.

The repository is a pnpm workspace and the deployable application is `apps/web`. Vercel
builds from the repository root, where there is no Next.js app, so `vercel.json` names the
framework, builds the one workspace package, and points at `apps/web/.next` for the output.
Without it the build succeeds and the deployment then fails looking for a static `public/`
directory that this project does not have. `next` is declared in the root `devDependencies`
for the same reason: Vercel resolves the Next.js version from the `package.json` in the
directory it builds from, and refuses to deploy when it cannot find one.

The **Root Directory** in the Vercel project settings must therefore stay at the repository
root. Setting it to `apps/web` is the other supported arrangement — Vercel then detects
Next.js by itself and needs none of the above — but the two do not combine: with a root
directory set, Vercel reads `apps/web/vercel.json` and ignores the file at the root.
