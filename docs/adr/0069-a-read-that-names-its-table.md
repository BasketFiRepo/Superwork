# ADR 0069 — A read that names its table

**Status:** accepted · **Date:** 2026-08-21

## Context

The column detector answers one question — *which columns does the product read and never
write?* — and every increment for twenty in a row has been chosen from its output. It asks the
question in two halves, and until now only one half was careful.

The **write** half is precise: `writeSegments(body, table)` finds `INSERT INTO <table>` and
`UPDATE <table>` by name and looks only inside those statements' assignment lists. ADR 0066
tightened it further when a `WHEN (NEW.status = 'completed')` clause was being counted as a
write to `status` on all 96 tables.

The **read** half was `word.test(productCorpus)`: does this column's name appear anywhere in the
concatenated source of the product? That is not a test of whether a column is read. It is a test
of whether a *string* occurs.

The cost, measured: **24 of 73** entries in the "read by the product" section were columns
nothing reads.

- `citations.score` — `listCitations` does not select it.
- `notifications.delivered_at` — all nine `delivered_at` reads are `nudges.delivered_at`, in a
  file that also queries `notifications`.
- `insights.snoozed_until` — every read is `conversations.snoozed_until`.
- `tasks.starts_on` — every read is `projects.starts_on`.
- `email_accounts.last_sync_at`, `.last_error`, `.user_id`, `.scopes` — the `last_sync_at` reads
  are on `connections` and `identity_settings`.
- `events.actor_id`, `.actor_type`, `.entity_id`, `.entity_type`, `.trace_id` — **the product
  never touches the `events` table at all.** It was designed in migration 0005 and wired to
  nothing; `activities` and `audit_logs` do its job. Five of its columns sat on the queue
  because they are called `name`, `payload`, `entity_id`.

I proposed work from that list three times and withdrew it three times after going and reading
the code. A queue where one entry in three is imaginary is a queue that gets skimmed.

## Decision

**A read belongs to the table its statement is about.** `readSites(body)` returns
`table → columns`, built the way `writeSegments` is built — from what the SQL names.

**Only SQL is scanned.** Whole-file scanning would read `contact.name` in a React component as
a column read of `name` on every table: the same over-reporting from a different direction, and
worse because it would look like precision. Spans are the template literals that are SQL-shaped,
found with the same `statementEnd` the write side uses, so a literal that splices a fragment
carries the fragment's text with it.

**The SQL-shape test is case-sensitive, which is what lets it accept `AND` and `OR`.** SQL here
is written in upper case and prose is not, so a refusal message containing the word "or" is not
mistaken for a query. Without those keywords a fragment like `AND conv.archived_at IS NULL` — no
`SELECT` in it — would be dropped along with the only mention of the column it filters on.

**Scopes are bracketed spans.** A read belongs to the innermost span around it that names a
table, so `(SELECT count(*) FROM nudges WHERE … delivered_at …)` sitting inside a statement that
also counts `notifications` is attributed to nudges alone.

**Aliases are resolved across the file.** `n.delivered_at` follows `FROM nudges n`, and a
fragment written apart from its `FROM` — `AND conv.snoozed_until IS NULL` in one statement,
`FROM conversations conv` in the constant above it — still lands on conversations.

**The fallback is the old behaviour, deliberately.** A column named in a span that mentions no
table and carries no alias is attributed to every table. Over-reporting costs a candidate
somebody investigates and drops; under-reporting costs work nobody ever sees again. **And the
report now says how much of the count is that fallback** — currently 10 of 49 — so the number
carries its own confidence rather than being read as more than it is.

## The first version reintroduced the bug one level up

Analysing a file's SQL spans *joined together* gave every statement a fallback scope holding
every table the file mentions. So `SELECT delivered_at … FROM nudges` in a file that also
queries `notifications` credited both — the same failure, one level up, and it survived the
first two of my six known cases. The fix is to analyse one statement at a time, and there is a
test named for it.

## Consequences

- **73 → 49** columns reported as read, with 24 moved and **none moved the other way** — the
  direction that would have hidden work. Every one of the 24 was checked in the source by hand.
- The queue's headline is unchanged at 100, because this changes what is *known* about those
  columns rather than how many there are. What it changes is which of them are worth opening.
- `events` is now visibly a dead table rather than seven candidate controls, which is a finding
  in itself: it should be dropped, and that is its own change.
- Seven tests, including one for the file-joining mistake and one that asserts nothing in the
  real corpus reads `events`.
