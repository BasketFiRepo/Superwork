# ADR 0001 — PostgreSQL is the single data substrate

**Status:** accepted · **Date:** 2026-08-13

## Context
Superwork needs transactions, hard multi-tenant isolation, keyword search, vector search
and durable job state. The obvious alternative is a specialist per concern: Postgres for
records, a vector database for embeddings, a search engine for keywords, Redis for jobs.

## Decision
One PostgreSQL 16 instance with `pgvector` and `pg_trgm` provides all of it. Hybrid
retrieval fuses `tsvector` and `pgvector` results inside a single query, so the ACL
predicate is applied once, in SQL, to both arms.

## Consequences
- The retrieval ACL cannot drift between two systems, which is the failure mode that
  leaks a document into a prompt (§7.3).
- A chunk and the row that owns it are updated in one transaction; there is no window in
  which the index disagrees with the record.
- Above roughly 5M chunks per tenant this stops being the right answer. The retrieval
  interface (`hybridSearch`) is the seam: moving a whale tenant to a dedicated index is a
  config change behind that function, not a rewrite (§26.7).
