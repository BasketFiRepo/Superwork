# ADR 0044 — Who decided this was confidential

**Status:** accepted · **Date:** 2026-08-17

## Context
`documents.sensitivity_source` has existed since migration 0004 with a default of `'auto'`, and
nothing ever wrote any other value. It could not: there was no way anywhere in the product for a
person to change a document's classification at all.

So every classification in Superwork was a regex's opinion, recorded as though nobody had one:

- **A misclassification had no fix.** `classifyContent` matches the word *salary* and files a
  blank offer-letter template as `restricted`; it matches *rate card* and files a worked example
  as `confidential`. A false positive puts a document out of reach of the people who need it, a
  false negative leaves something over-shared, and neither had a remedy short of editing the
  database by hand.
- **An auditor could not tell a weighed decision from a guessed one.** §4.3 spends its length on
  what a classification *does* — who may read it, what retrieval will return, what an agent may
  quote. Nothing recorded where the classification came from, so "who decided this was
  confidential" had no answer for any document in the system.
- **The classifier could only ever raise.** It takes the highest of what it detects and the
  fallback it is given. Even a hand-edited row would be put straight back by the next re-index,
  which is a thing the product does on its own — so a correction would have looked like a bug in
  the correcting.

## Decision

**A classification is either read or decided, and the row says which.** `sensitivity_source` is
constrained to `auto | human`; a human classification names the person, the moment and the
reason, and a CHECK constraint refuses one that does not. A decision nobody signed is exactly
what the column exists to stop being possible, so the database is what refuses it rather than
the one code path that happens to write it today.

**What the classifier read is kept, whether or not it wins.** `sensitivity_auto` is written on
every ingest. Recording only the outcome would resolve the disagreement and hide it; the whole
value to an auditor is seeing that a person read the content differently from the pattern, and
saying so on the screen.

**The classifier does not argue with the person afterwards.** Ingest reads the existing source
first and leaves a human level alone. This is the reason the feature is worth building rather
than an addendum to it: without it, the correction survives until the next re-index and then
silently reverts.

**Lowering asks for a fresh proof; raising never does.** Lowering below what the classifier read
widens who can retrieve the document, which is the irreversible direction — the passages reach
more people, and retrieval has already happened by the time anybody notices. Raising only ever
narrows, and asking for a password to make something *safer* teaches people to dismiss the
prompt. `document.declassify` joins `STEP_UP_ACTIONS`; the measure is against
`sensitivity_auto`, not against the current level, so a person cannot lower it a rung at a time
to avoid ever being asked.

**Nobody can file a document above their own ceiling.** A member whose reach stops at `internal`
cannot file something as `confidential`: they would be classifying a document they can no longer
open, which is a decision nobody can then check — and a way to make a document disappear from
somebody's own library without any permission changing.

**The decision reaches every passage, by trigger.** `document_chunks.sensitivity` is what
retrieval actually filters on. A correction that stopped at the document would leave every
passage carrying the level the person had just said was wrong. Somebody reclassifying a document
is deciding about the document and everything in it, and the cascade is a trigger rather than a
second statement in the repository because when two places must agree, the agreement is not
something application code should be trusted to remember (ADRs 0028, 0030, 0036, 0040, 0042).

**Handing it back is the only undo.** There is no "clear the human decision" that leaves the
level where the person put it — that would be a classification with no author again, the thing
this exists to end. Handing it back restores what the classifier read, at the document and at
every passage. The document's reading is also each passage's: a chunk is classified with the
document's level as its floor and can only detect what the whole text already detected, so the
two are equal by construction rather than by luck.

## What is deliberately not built

**A model in the classification path.** The detectors stay deterministic, so the classification
of a credential does not depend on a model being available (§5.9.6). What is new is a person's
say, not a better guess.

**Bulk reclassification.** A screen that files a hundred documents at once is a screen whose
reason field says "bulk update" — which is not a reason, and the constraint would accept it. The
correction is per document because the judgement is.

**A review queue for the disagreements.** The index (`documents_human_classified_idx`) and the
recorded `sensitivity_auto` make "everything a person overrode" a single query, and the
compliance screen can grow one when there is a workflow to hang on it. Building the queue before
the workflow would be a list nobody is answerable for acting on.

## Consequences
- `DocumentView` carries the source, the classifier's reading, the person's name, the moment and
  the reason, so the panel is rendered from SQL rather than from a second fetch.
- The panel sits on the document page beside the classification it explains, and renders
  `{stepUp.prompt}` itself — the proof is asked for next to the thing it protects.
- Documents indexed before this migration have a null `sensitivity_auto`; the lowering check
  falls back to the level on the row, so the first correction on an old document is measured
  against what it currently claims.
- The audit record carries the level before, the level after, the reason and what the classifier
  read, which is the whole of the disagreement in one row.
- **The re-index passes the classifier's own last reading as its floor, not the level in force.**
  Passing the level a person set would floor the classifier with their decision and record it as
  though the pattern had read it — the disagreement would vanish on the next re-index, which is
  the same failure this ADR exists to fix, one level up.
- **The re-index restates the document's term.** Chunks are written fresh on every re-index and
  the queue did not carry `effective_from` / `effective_to`, so re-indexing an expired contract
  silently returned every passage of it to circulation as current — the one thing ADR 0042
  exists to stop. The acceptance loop found it, because the loop re-indexes a real document and
  the terms beat then read the passages. It is fixed here for the same reason the queue already
  restates the filing: "a re-index cannot quietly unfile the document" was written about
  `company_id`, and a term is no different.
