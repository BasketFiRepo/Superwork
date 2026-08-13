# ADR 0006 — Append-only auditing that still permits erasure

**Status:** accepted · **Date:** 2026-08-13

## Context
`audit_logs` must be append-only so history cannot be rewritten (§3.6). Retention
policies and subject-access deletion must genuinely cascade, including derived records —
a deletion that leaves audit rows behind is a compliance hole (§21). A trigger that
refuses every `DELETE` makes the second requirement impossible.

## Decision
A trigger refuses `UPDATE` for every role, unconditionally. It refuses `DELETE` for
`superwork_app`, which additionally has the privilege revoked. `DELETE` by the owner role
is permitted, which is how the retention job, the erasure workflow, and `ON DELETE
CASCADE` from a purged organization complete.

## Consequences
- The application can never alter or remove an audit row, by trigger and by privilege.
- Erasure runs through a named, reviewable job rather than an ambient capability.
- The boundary is the database role, so it is visible in `pg_roles` and asserted by the
  cross-tenant test pack rather than living only in application code.
