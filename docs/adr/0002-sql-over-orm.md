# ADR 0002 — Hand-written SQL migrations and a typed query layer, not an ORM

**Status:** accepted · **Date:** 2026-08-13

## Context
The specification names Drizzle as the preferred ORM, with the required properties being
"explicit SQL escape hatch, migration control".

## Decision
`postgres.js` tagged templates with a hand-written repository layer, and numbered
`.up.sql` / `.down.sql` migration pairs.

## Rationale
The schema's load-bearing parts are things ORMs express badly or not at all: forced row
level security with per-role policies, an append-only trigger on `audit_logs`, partial
indexes on hot predicates, HNSW index parameters, `CHECK` constraints that make prohibited
monitoring configurations unstorable, and a hybrid retrieval query with a CTE per
retrieval arm. Writing these through a migration generator means writing raw SQL anyway,
with a second source of truth to keep in step.

## Consequences
- Every parameter is still bound; no query is built by string concatenation, and no model
  output ever reaches the database as SQL.
- Row shapes are hand-maintained in `packages/db/src/types.ts` alongside the migrations.
  A column renamed in SQL and not in TypeScript is caught by the integration tests, not by
  the compiler — this is the cost of the decision.
- Adopting Drizzle later means introspecting the existing schema, not rewriting it.
