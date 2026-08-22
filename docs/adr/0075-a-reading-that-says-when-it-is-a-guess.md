# ADR 0075 — A reading that says when it is a guess

**Status:** accepted · **Date:** 2026-08-22

## Context

The column-coverage detector chooses what gets built. Its report ended with a line like:

> 91 that no product write touches — 41 of them read by the product, 8 of those placed by the
> fallback rather than by a statement.

Eight of forty-one readings were guesses, and the report said **how many** without saying
**which**. That is a reading nobody can act on: the only way to tell a candidate from a phantom
was to patch a copy of the script by hand and run it, which is what finally happened — after
three of the eight had been offered as build candidates and `document_versions.note`, a column
nothing selects anywhere, was most of the way to being built.

So the first question was how to label the guesses. Labelling them turned up the better question:
where were eight guesses coming from at all? The report named the files, and they were React
components. `AddCompany.tsx`, `AgentStudio.tsx`, `Invitations.tsx` — client components with no
SQL in them.

## What was actually wrong

`sqlSpans` confines the read scan to SQL, which ADR 0069 established. It ends with a branch for
`.sql` files, which are all statements and carry no backticks:

```ts
if (spans.length === 0 && /\b(SELECT|INSERT\s+INTO|UPDATE|CREATE\s+TABLE)\b/i.test(body)) {
  spans.push(body)
}
```

The comment said "a `.sql` file". The test did not. `/…/i` matches the **word** "update" in any
file, so a component with a function called `update` and no SQL in it had its entire body pushed
as one statement. Nothing in that body names a table, so every `x.y` in it landed on `ANY_TABLE`
— and `ANY_TABLE` lends a column name to all ninety-six tables at once.

That produced every one of the eight. It is the same failure ADR 0069 fixed one level up, left
behind in the one branch that scans a whole file on purpose: the fallback is the safe direction
only when it fires on something that is actually SQL.

## Decision

**The whole-body branch fires only for `.sql` files**, which is what its own comment always said.
`readSites` takes the fact from the file's extension. That took the guesses from eight to one.

**Comments are prose, not statements.** The survivor was `memberships.title`, from
`-- the same argument the relationship view makes about a restricted contract's title` inside a
real statement in `inbox.ts`. Spans are scanned with their comments blanked out. That took it to
zero.

**And the report separates what it could not place**, because the two fixes above are today's
answer and the fallback is permanent — a query assembled from strings will produce one again.
Guesses now sit in their own section, out of the work list, each naming the files the column name
was seen in, so the next one is resolved by opening a file rather than by patching this script.

The headline count changes with it: **33 read by a statement that names the table**, and any
guesses reported apart and not counted among them.

## What the tests had to be taught

Both fixes were written with a test beside them, and both tests had to be corrected before they
were worth anything.

The comment test passed **with and without the fix** while it used a synthetic span — the
apostrophe and the surrounding structure of the real comment were what made it misread. It is now
pointed at `inbox.ts` itself, and it fails when the fix is reverted. A test that agrees with you
either way is worse than none, and this one agreed for twenty minutes.

The second was a claim rather than a test. `withoutComments` blanks comments to spaces instead of
deleting them, and the note beside it said offsets would otherwise shift and hand a read to the
wrong scope. Deleting them passes every test in the file, because `scopesOf` is handed the same
stripped string and both sides move together. The note now says the blanking is caution, not a
requirement — an unstated-but-true reason is fine; a stated-but-false one is a trap for whoever
edits it next.

## Consequences

- Every reading on the work list is now placed by a statement that names its table: **41 → 33**,
  with the eight phantoms moved to "not read by the product either", where they belong.
- `document_versions.note`, `memberships.title`, `projects.key`, `email_accounts.address` /
  `provider` / `status` and `events.name` / `payload` come off the queue — not because anything
  was built, but because they were never on it.
- The number of columns needing work did not change (91). What changed is that the list can be
  believed.
