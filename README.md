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
pnpm test              # 668 assertions: units, isolation, permissions, briefing, injection, ledger, studio, scale
pnpm test:isolation    # the cross-tenant pack on its own
pnpm eval              # the agent eval harness — golden, adversarial and refusal packs
pnpm loop              # the Phase 1 acceptance loop, start to finish
pnpm loop:phase2       # triage → meeting → account → briefing, with assertions
pnpm loop:phase3       # ledger → create/simulate/publish an agent → personal record → API key
pnpm loop:phase4       # fair scheduling → works-council review → nudge budget → sharing
pnpm loop:phase5       # describe → dry-run → activate → run → approve with edits → custom tool → memory → access → dependencies → teams → flags → sharing
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
- Only the task, document and project lists are scope-aware. The other list endpoints still
  gate at organization level, which is right for every role above `guest` and wrong in the
  same way for `guest`.

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

- The share panel is on tasks, documents and projects. Companies and knowledge spaces are
  shareable in the type and have no detail page to put a panel on.
- A container share reaches one level and one relationship: a project's tasks. Documents and
  meetings belong to things too and are not wired up. A rule with one caller is easier to
  reason about than one with four and a test pack for one of them.
- Sharing a project adds nobody to a circulation list, so a restricted document inside a
  shared project stays restricted. "Shared the project" and "the assistant can cite
  everything in it" are different statements, deliberately.
- `project_members` is written by the seed and read by nothing. It carries one row per
  project — the owner, who is already on the project row — so it says nothing the product
  does not already know. Sharing is the mechanism that grants project access.
- There is no organization-wide view of every share. `sharedWith` is self-only, so an access
  review is done object by object — the honest substitute until the roll-up is worth the
  permission it would need.
- Four of the ten feature flags — `reports`, `autopilot`, `chat_presence`, `public_api` —
  are read by nothing. They are listed on the Features screen as inert rather than given a
  switch, because a control that changes nothing is worse than an absent one.
- Seven tables are dead schema that nothing reads *or* writes: `agent_messages`,
  `email_accounts`, `events`, `ingestion_jobs`, `invitations`, `saved_views` and
  `task_watchers`. They are left in place rather than dropped, and listed here so nobody has
  to rediscover them. Unlike the tables this work was about, none of these has a live reader,
  so none is silently affecting behaviour.
- The demo organization ships with no feature-flag overrides, because seeding one would mean
  turning a feature off in the demo.

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

## Configuration

Every variable is validated at boot with Zod and the process refuses to start on a bad
config. `vercel.json` points the platform at the workspace build (`pnpm --filter
@superwork/web build` → `apps/web/.next`), and `next` is a root devDependency so the
framework detector finds it when the project's Root Directory is the repository root —
set Root Directory to `apps/web` instead and neither is needed; a hosted deployment still needs `DATABASE_URL`
pointing at a PostgreSQL 16 instance with `pgvector` and `pg_trgm`, `SESSION_SECRET`, and
the migrations applied — the app boots against an empty database but every screen is a
sign-in wall until `pnpm db:seed` or a real organization exists. `AI_MODE`, `EMAIL_MODE`, `CALENDAR_MODE`, `STORAGE_MODE` and `BILLING_MODE` each
resolve to `mock | sandbox | live`, and the resolved mode is rendered in the interface
wherever it affects what you should believe. `AUTOPILOT_ENABLED` is rejected while
`AI_MODE=mock`.

## Deployment

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
