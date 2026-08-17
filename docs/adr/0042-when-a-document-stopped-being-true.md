# ADR 0042 — When a document stopped being true

**Status:** accepted · **Date:** 2026-08-17

## Context
`documents.effective_to` and `document_chunks.effective_to` have existed since migration 0004
and nothing has ever written to them or read them. Neither did their opening halves, quite:
`ingestDocument` accepted an `effectiveFrom` and copied it onto every chunk, but no caller ever
passed one — so both ends of every document's term were blank on every row.

Nothing recorded when a document started applying, and nothing recorded when it stopped. The
second is the one that produces a wrong answer.

Retrieval already handles one kind of out-of-date: a **superseded version** is filtered out of
default search and down-ranked when included (§7.3). That covers the case where something
replaced the document. It does not cover the case where **nothing replaced it and the term
simply ran out** — a rate card for a calendar year, a fixed-term supplier agreement, a policy
valid until review. `is_superseded` stays false, so the passage was retrieved, ranked and
cited as current indefinitely. An expired clause quoted with a citation is worse than no
answer, because it looks like an answer.

I initially pointed at the demo's 2024 Master Services Agreement as the example. That was
wrong: the seed marks its chunks superseded, so it was already excluded. The real gap is the
fixed-term document with no successor, and the demo had no example of one — it now has last
year's rate card.

## Decision

**Expired is not deleted.** The passage stays findable and stops being authoritative. "What
did the old rate card say" is a real question — an invoice query needs last year's prices —
and removing the answer would make it unanswerable rather than merely un-authoritative. Same
treatment a superseded version already gets, for the same reason.

**Expiry is decided at read time, never baked into a passage.** A passage is written once at
ingest; whether it has expired depends on today. The demo makes the point twice over: the 2024
agreement's term is closed by the amendment that supersedes it, which happens *after* its
chunks were written, and any document's term can be changed afterwards. So retrieval and the
grounding label decide expiry, both comparing against the organization's today (§26.5), and the
passage itself carries only the dates — in a column, not in its text (see below).

**The judgement is stated where the model can see it.** Down-ranking makes an expired passage
unlikely to arrive; it cannot make it impossible. So the grounding block's label — which is
product-authored, never the retrieved text — says `(EXPIRED 2025-12-31 — not current; say so if
you cite it)`. Retrieved content is not edited on its way to the model.

**Expired weighs the same as superseded, and they multiply.** Both mean "the right passage for
a question about the past, the wrong one for a question about now". A superseded version of an
expired contract is twice as far from current.

**`currentOnly` is off by default.** A caller that wants only what is in force says so. Making
that the default would quietly delete the past from every answer.

**A chunk's dates are its document's**, kept by trigger. `ingestDocument` writes them at ingest,
which is right then and wrong from the next edit onwards: the passage is what the model reads,
so it cannot go on claiming a term the document has changed (ADR 0028).

**Superseding something closes it.** When one document's version supersedes another's and the
new one states when it takes effect, the old one stopped applying the day before — that is what
supersession *means*, and leaving it to be typed twice is how it goes untyped. The trigger only
fills a blank: a date somebody stated explicitly is theirs, and overwriting it would be the
product arguing with the person who knows the contract.

**The contextual header carries no dates at all, because it is embedded.** It had a branch for
`effective_from` from Phase 1 and no caller had ever passed one, so it had never run. The moment
terms were seeded onto the Halden agreement and its amendment, the dates entered the vector,
diluted it, and pushed the amendment out of retrieval — `golden.supersession` failed, which is
exactly what that fixture is for. A term is a fact retrieval reads from a column, not a phrase
that belongs in an embedding. Which also means changing a term needs **no** re-index: there is
nothing in the passage to rebuild.

## Consequences
- Setting a term needs `document:update`: closing one takes the document out of every current
  answer the assistant gives, which is not something a reader should be able to do.
- The knowledge health panel counts what is out of term and what expires within thirty days —
  a question nothing could answer.
- The demo gains last year's rate card, out of term with no successor, and states the terms of
  the Halden agreement and its amendment so the supersession trigger has something to derive.
- Changing a term needs no re-index, so `setEffectiveDates` queues none. An earlier draft did,
  which was work the product would have been pretending was necessary.
- A term that ends before it starts is refused by CHECK on both tables, not only in the
  repository.
