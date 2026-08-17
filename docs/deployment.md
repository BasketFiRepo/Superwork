# Deploying Superwork

The deployable application is `apps/web`. It needs a PostgreSQL 16 database, the migrations
applied to it, and four environment variables. It runs entirely on mock capabilities, so it
needs no external credentials to be fully usable — the AI, email, calendar, storage and
billing modes all default to `mock`.

Two things about this repository determine most of what follows, and both are consequences
of decisions made for good reasons elsewhere:

- **The runtime never connects as the table owner.** An owner bypasses row level security,
  which is layer one of three in the isolation model (§3.2, ADR 0003). The request path
  connects as `superwork_app` or `superwork_auth`, neither of which owns a table or holds
  `BYPASSRLS`. Configuring a deployment means configuring three roles, not one.
- **The application fails fast on a bad environment** (§2.3). It does not start with a
  half-configured database and discover the problem under load. A deployment missing a
  variable serves one page that says so, on every route, until it is fixed.

## 1. Provision the database

PostgreSQL 16 with three extensions, created by `migrations/0001_foundation.up.sql`:
`vector`, `pg_trgm`, `pgcrypto`. Neon and Supabase both provide all three. Any managed
Postgres works if you can create roles on it.

Take two connection strings:

| | Used for | Notes |
|---|---|---|
| **Pooled** | `DATABASE_URL` | The request path. On Neon this hostname contains `-pooler`. |
| **Direct** | `DATABASE_ADMIN_URL` | Migrations, seeding, and the admin pool. |

The pooled string matters on a serverless host: each instance opens up to ten connections
(`packages/db/src/client.ts`). The driver is already configured with `prepare: false`,
which is what pgbouncer in transaction mode requires, so no further change is needed.

`DATABASE_ADMIN_URL` is not optional in production despite falling back to `DATABASE_URL`.
The web runtime uses the admin pool directly for invitations, erasure and retention, and
those belong on a direct connection rather than through the pooler.

## 2. Apply the schema

Migrations run from a machine that can reach the database, not from the deployment's build.
Point the repository's `.env` at the new database and run:

```bash
pnpm install
pnpm db:migrate
```

Use `db:migrate`, **not** `db:reset`. Reset drops and rebuilds the schema and then grants
on it to a role literally named `postgres`; it is the development and CI path, and on a
hosted database whose owner is called something else it fails.

Seeding comes after the next step, not here. The seed writes the demo organization's rows
through the tenant pool, as the `superwork_app` role, so that role's password has to be
right before it will run at all.

## 3. Give the runtime roles a password the deployment knows

`migrations/0008_rls.up.sql` creates `superwork_app` and `superwork_auth` with the
password `superwork_dev`, because a migration cannot know the one you will use. Choose one
of two ways to resolve that; the second is usually right for a hosted database.

**Either** set both roles to the same password as the owner in `DATABASE_URL`:

```bash
pnpm db:roles
```

It derives each password from the same function the connection pools use, so whatever the
runtime will present is what gets set. It also prints which database it reached — the
failure it exists to fix looks identical to having run the migrations against a different
branch, and that is the more common mistake of the two. The equivalent by hand is:

```sql
ALTER ROLE superwork_app  PASSWORD 'the password in DATABASE_URL';
ALTER ROLE superwork_auth PASSWORD 'the password in DATABASE_URL';
```

With no override set, `connectionFor` takes `DATABASE_URL` and replaces only the username,
so host, port, database and password all carry over. This is the simplest setup and the one
a self-hosted Postgres wants.

**Or** give each role its own credentials and name them outright:

```sql
ALTER ROLE superwork_app  PASSWORD 'a password you choose';
ALTER ROLE superwork_auth PASSWORD 'another password you choose';
```

```bash
DATABASE_APP_URL=postgres://superwork_app:...@host:6543/superwork
DATABASE_AUTH_URL=postgres://superwork_auth:...@host:6543/superwork
```

`pnpm db:roles` reads these too, so with the overrides in `.env` it sets each role to the
password its own URL carries rather than the owner's.

This is the better fit on a provider that issues the owner's password itself, since that
password cannot be handed to two roles a migration created. Each override must connect as
the role it is named for; one pointed at the owner is rejected at startup rather than
quietly granted the ability to read every tenant. When both are set, `DATABASE_URL` is only
the admin fallback and is passed to the driver verbatim.

## 4. Seed the demo organization

```bash
pnpm db:seed
```

The seed is what makes the product visible. Without it the app boots correctly and every
screen is a sign-in wall, because there is no organization to sign in to. It prints the
login on success — `maya@northwind.example` / `superwork`.

It has to come after step 3. Most of it is written through the admin pool, but the tenant's
own rows go through `withTenant`, which is the `superwork_app` role — so a seed run before
the passwords are set fails on `password authentication failed for user "superwork_app"`
partway through, having already written the rows that did not need a tenant.

Re-running it is safe: it deletes the `northwind` organization before rebuilding it, so a
half-written seed is cleaned up by the next attempt rather than doubled.

### Without a terminal

Steps 2 to 4 assume a checkout, a Node toolchain, and a database reachable from the machine
running them. None of that is a reasonable prerequisite for putting a schema on a database
you already own, so the same three commands are also a workflow:

1. **Actions → Provision the database → Run workflow**, on GitHub.
2. It needs two repository secrets first, under **Settings → Secrets and variables →
   Actions**: `DATABASE_URL` and `DATABASE_ADMIN_URL`, the same two strings as step 1.
3. Leave both tick boxes on for a first run. They map to `db:roles` and `db:seed`, so a
   later run can re-seed without touching the passwords, or the reverse.

It runs `db:migrate`, `db:roles` and `db:seed` in that order — the order matters for the
reason above — against whatever those secrets name, and prints the database it reached
before it writes anything. There is no push or schedule trigger: it writes to a real
database, so it only ever runs when somebody asks.

## 5. Set the environment variables

On the hosting platform, for the production environment:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the pooled string from step 1 |
| `DATABASE_ADMIN_URL` | the direct string from step 1 |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DATABASE_APP_URL` | only if you chose the second option in step 3 |
| `DATABASE_AUTH_URL` | only if you chose the second option in step 3 |

`SESSION_SECRET` matters as much as the database. A platform sets `NODE_ENV=production`
automatically, and the schema refuses the development default under it — leaving it unset
swaps one boot failure for another.

Everything else has a working default. The five capability modes resolve to `mock` and the
interface renders the resolved mode wherever it affects what you should believe.
`AUTOPILOT_ENABLED` is rejected while `AI_MODE=mock`: simulated output must never act
unattended.

Deploy again after setting them. Environment variables are read at deploy time, so an
existing deployment will not pick up new values on its own.

## 6. Verify

Load the site. You should get the sign-in page.

If the environment is incomplete you get a page headed **Not configured** listing every
variable that is missing or invalid — all of them at once, not one per redeploy. That page
is the intended output of a misconfigured deployment; it means the application built and
started correctly and has nothing to run against.

## Vercel specifically

`vercel.json` at the repository root names the framework, builds the one workspace package
and points at `apps/web/.next`, because Vercel builds from the root where there is no
Next.js app. `next` is in the root `devDependencies` for the same reason: Vercel resolves
the Next.js version from the `package.json` in the directory it builds from and refuses to
deploy without one. Setting the project's Root Directory to `apps/web` instead makes both
unnecessary.

Set the environment variables for the Build environment as well as Production. The build
does not need a reachable database — no route is statically prerendered from one — but
keeping them consistent avoids a prerendered 404 page carrying a stale "Not configured"
body.

## Rotating a password

The owner's password is the one a provider issues, prints on a screen and mails around, so
it is the one most likely to need replacing. By default it is also the password the request
path presents, because the runtime URLs are derived from `DATABASE_URL` — which means
rotating it takes the site down until every copy is updated.

Moving the runtime roles onto their own credentials first fixes that permanently. Afterwards
the owner's password is used only by migrations, and rotating it is invisible to the running
application.

**Order matters, and the middle of it is a cutover.** A PostgreSQL role has one password, so
between changing it in the database and changing it in the deployment's configuration, the
request path is refused. It is short — a redeploy — but it is not zero, and doing the steps
in a different order makes it longer rather than avoiding it.

1. **Generate two passwords** for `superwork_app` and `superwork_auth`. Anything random; they
   never need to be typed by a person.
2. **Set them in the database.** Either the provider's SQL console, or add
   `DATABASE_APP_URL` and `DATABASE_AUTH_URL` as repository secrets and run the provisioning
   workflow with only *Set role passwords* ticked — `db:roles` reads the overrides and sets
   each role to the password its own URL carries.
3. **Add the same two URLs to the deployment** and redeploy. The cutover closes here: the
   request path presents the new passwords and the site answers again.
4. **Rotate the owner's password** with the provider. Nothing breaks — no runtime pool uses
   it any more.
5. **Update `DATABASE_URL` and `DATABASE_ADMIN_URL`** everywhere they are held: the
   deployment, and the repository secrets the provisioning and worker workflows read. Both
   are now only the admin connection.

After step 5 the owner's password can be rotated again at any time by repeating steps 4 and
5 alone, with no cutover at all.

Two things worth checking rather than assuming. Each override must connect as the role it is
named for — one pointed at the owner is refused at boot, which is the check working, not a
misconfiguration. And every place holding a copy has to be updated: a deployment updated but
a repository secret forgotten leaves the workflows authenticating with a password that no
longer exists, and they will not fail until they next run.

## The worker

`apps/worker` dispatches the outbox, indexes what is queued, runs due watchers and workflow
schedules, generates briefings and digests, delivers the nudge ladder and applies retention.
It is a long-lived process and a serverless host will not run it. Until it runs somewhere,
with the same environment, the interface works fully but queued email never dispatches and
scheduled workflows never fire — and nothing on any screen says so, which is the part that
makes it worth deciding rather than deferring.

**Resident** is what it was written for: `pnpm worker` on any host that keeps a process
alive — Railway, Fly, a small VM — with the same environment the web deployment has. It
polls every five seconds and schedules fire on the minute.

**Scheduled** is the fallback where no such host exists. `.github/workflows/worker.yml`
wakes every five minutes, works for a minute and stops. It needs the same repository
secrets as the provisioning workflow and runs on the same free minutes a public repository
already has.

`WORKER_MAX_RUNTIME_MS` is what separates the two. Unset — the default, and what a resident
deployment wants — the worker runs until it is signalled. Set, it finishes the pass it is on
and exits. Every interval in the loop is measured from zero, so a fresh process does one of
every job on its first pass; the jobs reached are the same either way, and the only thing
that changes is how long queued work waits.

That wait is the cost, and it is worth stating plainly: on the schedule, an email sits in
the outbox for up to five minutes past its recall window, and GitHub delays scheduled runs
when it is busy, so the real figure is sometimes worse. GitHub also disables scheduled
workflows in a repository with no activity for sixty days. Neither is a reason to avoid it
for a demonstration; both are reasons not to run an operation on it.

The scheduled worker keeps every capability in `mock` unless a repository *variable* says
otherwise, which is deliberate: this is the one part of the system that acts outward on its
own, and the default has to be the one that cannot email a real customer by accident.

## When it does not work

| Symptom | Cause |
|---|---|
| **Not configured**, naming variables | Step 4, or the deployment predates it |
| `password authentication failed for user "superwork_app"` | Step 3 — run `pnpm db:roles` |
| `superwork_app does not exist in this database` from `db:roles` | The migrations ran against a different database or branch than these credentials name |
| `role "postgres" does not exist` | `db:reset` against a hosted database; use `db:migrate` |
| `type "vector" does not exist` | `pgvector` not available on the database |
| Sign-in page loads, correct credentials rejected | Step 2's seed did not run |
| `too many connections` | `DATABASE_URL` is the direct string, not the pooled one |
| `must connect as the superwork_app role` | An override in step 3 names the owner |
