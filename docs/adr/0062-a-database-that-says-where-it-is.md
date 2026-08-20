# ADR 0062 — A database that says where it is

**Status:** accepted · **Date:** 2026-08-20

## Context

The hosted deployment answered every request with this, for five hours:

```
Application error: a server-side exception has occurred while loading
superwork-six.vercel.app (see the server logs for more information).
Digest: 3919100423
```

The application was correct. `permission_grants` — created by migration 0051 — had never been
applied to that database, so `loadActor`, which runs on every authenticated request, threw
`42P01 relation "permission_grants" does not exist`. A second error on `/reminders` named
`department_closures`, migration 0047. The database was two releases behind the code standing on
top of it, and nothing in the product said so.

Finding that out took the platform's log viewer, a search for the digest, and knowing that an
`undefined_table` on a table added two releases ago means the schema is behind rather than the
application broken. None of that is available to the person looking at the page.

`layout.tsx` has made this exact argument since Phase 0, about a different cause:

> Every screen below reads the environment on its first render, so one missing variable is an
> unhandled throw on every route at once — and **a throw during a render reaches the browser as a
> digest and nothing else**. Checking here costs one schema parse per request and turns that into
> a page that says which variable it is.

A database behind the application is the same failure with a different cause, and the same
sentence applies word for word. There was no reason for it to be treated differently, other than
that nobody had been bitten by it yet.

It is also not a one-off. Every migration-bearing merge produces it: the deploy is automatic and
the migration run is a workflow somebody has to remember. The next one was already queued when
this was written.

## Decision

**The root layout asks whether the database matches this build, and renders a page that names
what has not been applied.** Second, not first: with no environment there is no database to ask.

**It reads through the application's own pool.** `adminSql` is documented as migrations, seeding
and diagnostics, *never* request handling, and a test asserts no runtime pool points at the owner.
That meant the runtime role could not read `schema_migrations` at all, so migration 0055 grants it
`SELECT` — four columns of deployment metadata carrying no tenant data, no `organization_id` and
no RLS. `SELECT` only: a runtime that could write the ledger could tell itself the schema is newer
than it is, and a test asserts the write is still refused.

**Once satisfied it never asks again.** A schema that matches this build cannot stop matching it
without a deploy, so the check costs one round trip per process and nothing after. While it is
*not* satisfied it is asked on every request — which is what lets a deployment recover the moment
somebody applies the migrations, with no redeploy. The provisioning workflow already promises
exactly that; this is what makes the promise true.

**A privilege error is an answer, not a shrug.** This is the part that nearly made the whole thing
useless, and it was only found by reproducing the outage rather than reasoning about it. A
database that is behind is also a database without migration 0055 — so the check loses the
privilege to enumerate precisely when it is needed. Answering "cannot tell" there would have shown
a digest on the day this shipped, which is the failure it exists to remove. So `42501` is read as
*behind, and unable to say by how much*, and the page says that in those words rather than
pretending to a list it does not have.

**Anything else stands aside.** A query that fails for a reason the check does not recognise
reports `unknown` and the request carries on to whatever it was going to do. The point is to
explain a failure that was going to happen anyway, never to become one.

**The list of migrations is a constant, and a test keeps it honest.** The application cannot read
the migrations directory at runtime: a serverless bundle contains the code the tracer found, not a
directory of SQL nothing imports. So `MIGRATIONS` is checked in — and a constant is a second place
a fact lives, which is how the outage happened in the first place. `tests/unit/schema-manifest.test.ts`
refuses it the moment it stops matching the directory, so a migration added without a line there is
a red build rather than a surprise in production.

## Verification

Reasoning about this was not enough — the privilege case was invisible until the outage was
rebuilt. So it was rebuilt twice, against a real browser response:

- **The production shape.** Roll the database back five migrations, start a fresh server: the code
  is from 0055, the database is at 0050, `permission_grants` is gone. Before this change that is
  `500` and a digest. After it, `200` and *"The database is behind"* — by the opaque path, because
  rolling back that far also removes the grant, which is exactly what the first real deployment
  meets.
- **The shape every future release makes.** Grant present, two later migrations missing: `200`,
  *"2 migrations behind"*, and both named on the page.
- **The recovery.** Applying them against the same running process, with no restart, returns the
  site to normal on the very next request.

Plus: 1,210 tests, `db:rollback && db:migrate` over seeded data, the eval pack at 100%, all five
acceptance loops twice on one bootstrapped database, and the browser check green on a fresh demo.

## What this does not do

It does not run migrations automatically on deploy. That was the other option and it is worse
here: a deploy that migrates is a deploy that can half-migrate a live database while the previous
build is still serving from it, and this product's migrations include a `DROP COLUMN` (0051) that
an older running build reads. Explaining the gap is honest; closing it by racing a schema change
against live traffic is not.

It does not detect a database *ahead* of the application — a rolled-back deploy against a migrated
database. `comparePending` ignores ids it does not know, and a test says so, because reporting
those as pending would be a lie. That failure has its own shape and has not happened yet.

## Consequences

- A deployment whose database is behind says so, on every route, naming the migrations and the two
  ways to apply them — instead of a digest that requires log access to decode.
- It recovers on the next request once they are applied. No redeploy.
- Migration 0055 lets the runtime read the migration ledger and nothing else.
- The next migration-bearing merge — there is one open — will show this page rather than repeat
  the outage.
