# ADR 0025 — A shelf is a container, an account is not

**Status:** accepted · **Date:** 2026-08-15

## Context
ADR 0024 left companies and knowledge spaces in `ShareableType` with no panel. Companies had
a detail page; knowledge spaces had nothing at all.

The knowledge space was worse than unbuilt — it was **impossible**. A tuple names the object
`knowledge_space`; the permission catalogue has always spelled the domain `knowledge`.
Nothing reconciled the two, so `can(actor, 'knowledge_space:read')` matched no grant any role
holds. The type was declared shareable, and nobody below `owner` could share, or even read,
one. `relationGrant` looked tuples up under the action's prefix alone, so even the tuple
could not have rescued it.

Underneath that, `knowledge_spaces` had been in the schema since migration 0004 with a
seeded row and no reader, and `documents.space_id` was written on every document and
selected by nothing. Four more defects came out with them.

## Decision

**A shelf is a container; an account is not.** ADR 0024's rule extends to knowledge spaces
unchanged — sharing one lends a read of the documents filed in it — and deliberately does
not extend to companies.

The distinguishing question is *does the content have another home?* A task lives in a
project. A document lives in a space. But a company does not contain its threads,
commitments and documents — it is a *party* to them, and each lives in the inbox, the ledger
or the library, with its own governance. Lending all of that on one tuple would be the coarse
over-grant ADR 0024 exists to refuse. So a company share hands over the account view and
says, on the panel, what it does not reach.

**A space carries no classification, so it lends reach and nothing else.** `default_sensitivity`
is the default applied to documents filed into it, not a statement about the space, and it
is *not* used as a container ceiling. Each document is checked against its own
classification, which is where the classification actually lives. Sharing the Operations
shelf with a contractor opens the shelf and leaves every `internal` document on it shut.

**The permission resource is an explicit table.** `PERMISSION_RESOURCE` maps each shareable
type to the domain that governs it, and `relationGrant` looks a tuple up under the object's
own type as well as the action's prefix. Kept as a table rather than a string transform,
because the next mismatch will not be one an `s`-stripping rule would have caught either.

**A list gate must consider what has been given.** Every scoped list refused outright when
`grantedScope` returned null — before any row was considered, and regardless of tuples. A
`guest` holds no `knowledge` grant at all, so a space *given* to them was denied by the gate
that runs before the predicate the tuple was supposed to satisfy. This is ADR 0021 one level
further down: all four lists now refuse only when there is genuinely nothing to ask about,
and a null scope contributes `false` to the predicate rather than falling through to the
"own rows" branch.

**Retrieval must union in what was given.** A narrow role's search was hard-filtered to its
own teams, which threw away everything it had been handed: a document shared with a guest
joined its circulation list and then failed the team test, so the page opened and the
assistant could not find it. That was ADR 0023's own fix, half-applied. Search now unions
shared documents and shared spaces exactly as the list does.

**Indexing is not a reason to forget where something lives.** `ingestDocument` *assigned*
`company_id`, `project_id`, `space_id`, `owner_id` and `department_id` from its own input,
so any caller that asked only for indexing unfiled the document. The seed did precisely
that: it inserted every document into the Operations space and the next statement set
`space_id` back to `NULL`. That is why the spaces table looked disconnected from
everything — it never was, the filing was being erased a millisecond after it was written.
Those five columns are now `coalesce(new, existing)`.

**The company 360 view stopped trusting one check.** It gated once on `company:read` and
then returned every task and document filed against the company, including ones the reader
could not open from their own screens — a `restricted` contract listed by name is content.
Its task list now respects the reader's task scope and its document list their
classification. That leak predates sharing; a company share would have made it an easy way
in.

## Consequences
- `containers` now has two callers and a stated test for which things qualify. Meetings and
  conversations belong to companies and are still not wired up, and under this rule they
  never will be by container: they have their own home.
- A space share does reach retrieval, which a project share does not. That is not an
  inconsistency — a project has no relationship to the index, and a space is the shelf the
  index is organised by.
- Sharing a space does not add anybody to a document's circulation list. A document
  restricted to a named list stays restricted, and this is why: adding the first name to a
  document with no list *removes everybody else*, so syncing a space share across a shelf
  would silently restrict every document on it.
- Every shareable type now has a panel. `ShareableType` and the interface finally agree.
- `knowledge_spaces` has one seeded row and no way to create a second from the interface.
  Spaces are read, shared and filed into; they are not yet authored.
