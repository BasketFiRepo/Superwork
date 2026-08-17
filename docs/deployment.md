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
pnpm db:seed     # the Northwind Logistics demo organization
```

Use `db:migrate`, **not** `db:reset`. Reset drops and rebuilds the schema and then grants
on it to a role literally named `postgres`; it is the development and CI path, and on a
hosted database whose owner is called something else it fails.

The seed is what makes the product visible. Without it the app boots correctly and every
screen is a sign-in wall, because there is no organization to sign in to. It prints the
login on success — `maya@northwind.example` / `superwork`.

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

### Without a terminal

Steps 2 and 3 assume a checkout, a Node toolchain, and a database reachable from the
machine running them. None of that is a reasonable prerequisite for putting a schema on a
database you already own, so the same three commands are also a workflow:

1. **Actions → Provision the database → Run workflow**, on GitHub.
2. It needs two repository secrets first, under **Settings → Secrets and variables →
   Actions**: `DATABASE_URL` and `DATABASE_ADMIN_URL`, the same two strings as step 1.
3. Leave both tick boxes on for a first run. They map to `db:seed` and `db:roles`, so a
   later run can re-seed without touching the passwords, or the reverse.

It runs `db:migrate`, `db:seed` and `db:roles` in that order against whatever those secrets
name, and prints the database it reached before it writes anything. There is no push or
schedule trigger — it writes to a real database, so it only ever runs when somebody asks.

## 4. Set the environment variables

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

## 5. Verify

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

## The worker

`apps/worker` drives the outbox, workflow schedules and watchers. It is a long-lived
process and a serverless host will not run it. Until it runs somewhere, with the same
environment, the interface works fully but queued email never dispatches and scheduled
workflows never fire.

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
