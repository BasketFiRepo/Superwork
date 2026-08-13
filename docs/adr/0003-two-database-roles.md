# ADR 0003 — Two non-superuser database roles

**Status:** accepted · **Date:** 2026-08-13

## Context
RLS only protects a tenant if the connecting role cannot bypass it. Table owners bypass
RLS unless `FORCE ROW LEVEL SECURITY` is set, and superusers bypass it unconditionally.
Login also creates a bootstrap problem: resolving an email to a session happens before any
organization is known, so `app.current_org` cannot yet be set.

## Decision
Tables are owned by the migration role. Two separate login roles, neither superuser and
neither holding `BYPASSRLS`, serve the application:

- `superwork_app` — the tenant runtime. Sees exactly one organization, chosen by the
  `app.current_org` session variable that `withTenant` sets inside a transaction.
- `superwork_auth` — reaches `users`, `sessions`, `memberships` and `organizations` only,
  and exists solely to turn a login into a session.

## Consequences
- A forgotten `WHERE organization_id = ?` cannot leak a tenant; the policy still applies.
- `FORCE ROW LEVEL SECURITY` is set on every tenant table so ownership is not a loophole.
- The cross-tenant test pack asserts both roles lack `BYPASSRLS` and `SUPERUSER`, so a
  future migration cannot quietly grant either.
