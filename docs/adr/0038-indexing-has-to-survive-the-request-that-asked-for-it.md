# ADR 0038 — Indexing has to survive the request that asked for it

**Status:** accepted · **Date:** 2026-08-15

## Context
`ingestion_jobs` was created in migration 0004 with `attempts`, `last_error`,
`chunks_written`, `priority` and a `verification` jsonb, and nothing has ever written a row.
Ingestion ran inline inside the caller's transaction instead. That hid three things.

**A failed upload left nothing.** `ingestDocument` marks the document `failed` and then
rethrows. The rethrow aborts the enclosing transaction, so the document row *and* the failure
record roll back together. The person was told it did not work, and the product kept no
evidence it had ever been tried — nothing to retry, nothing to count, nothing on a screen.

**There was no re-index path at all.** Not a button, not an API, not a tool. A document
indexed while the embedding provider was misbehaving stayed that way permanently, and so did
one whose post-index check had warned that a section was unfindable.

**The verification result was thrown away.** This is the correction to a claim made earlier
in this build: the §7.1 *Verify* stage does run, on every ingest. What it produces was
discarded — its warnings flattened into `documents.index_error`, a column that also holds
failure messages, so "indexed, but two sections are hard to find" and "did not index at all"
read identically to anything reading that column.

## Decision

**Indexing is a queue, and the queue is the history of every ingestion** — not only of the
attempts that needed retrying. An ordinary upload still indexes inline, because a document
that is not indexed is not memory and making somebody wait for a worker would be a worse
product; what changes is that the attempt leaves a row. "When was this indexed, into how many
sections, and what did the check find" now has an answer for every document.

**A failure is retried on a widening delay and then stops out loud.** Five attempts, then the
job gives up, writes to the activity feed, and appears on the knowledge screen as somebody's
decision. A queue that retries for ever is a queue that never tells anybody anything is
wrong — the same reasoning as the outbox's dead-letter terminus (§2.4).

**Each job runs in its own transaction, and a failure is recorded in a further one.** Both
matter. A database error inside `ingestDocument` aborts the transaction it happened in, so
writing the failure on that same connection would silently fail too and leave the job
`processing` for ever with nothing to say why.

**The lifecycle is a CHECK constraint, not a convention.** `pending` knows when it is next
due; `processing` knows when it was claimed; `failed` is either coming back
(`next_attempt_at`) or has given up (`finished_at`) and never both and never neither. No
writer has to remember the rules because the database will not accept a row that breaks them.

**Re-indexing needs a say over the document, not a read of it.** It writes a new version,
supersedes the old passages and can change the document's classification. A reader being able
to set that off would be a reader editing the document by another route.

**A job that gave up is woken, not replaced.** Pressing "try again" keeps the attempt count it
gave up on, so the record reads "we tried five times, then Maya decided to try again" rather
than starting from zero and losing what it cost.

**One live job per document**, by partial unique index. Queueing a re-index twice while the
first is still waiting would index the same body twice and write two versions of it. And both
ends of a job belong to one organization, enforced by a trigger — the runner reads the body of
whatever document the row names, so a row crossing tenants would index one company's contract
into another's memory. Same reasoning as ADR 0034's watcher trigger.

## Consequences
- The worker gains an indexing beat on the outbox's cadence: it is the same kind of work,
  something a person asked for that must outlive the request they asked it in.
- A document with no stored body is `skipped` by name rather than failed five times — its
  body only ever existed in the request that uploaded it, so there is nothing to retry.
- Purging a document deletes its jobs explicitly (§25.13). The foreign key cascades, but the
  guarantee should not depend on a schema detail written two migrations away.
- The demo seeds a job per seeded document, so the panel shows real history rather than an
  empty table. No fabricated failure is seeded: the failure path is exercised by the test
  pack and the phase-5 loop, both of which break the embedding provider for real rather than
  hand-writing rows that look broken.
- Verification warnings are now visible per document and distinguishable from failures, which
  is what the `verification` column was for.
