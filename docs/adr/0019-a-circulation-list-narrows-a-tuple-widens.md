# ADR 0019 — A circulation list narrows, a tuple widens

**Status:** accepted · **Date:** 2026-08-15

## Context
`document_permissions` was created in migration 0004 and nothing has ever written to it. It
is read in three places that matter — both arms of `hybridSearch`, and since ADR 0018 memory
recall as well — so its branch has been evaluated on every retrieval since Phase 1 and has
never matched anything.

Meanwhile `relation_tuples` *did* get built, and `share()` writes them for documents among
other objects. So the product had two grant mechanisms, one of them dead, and they disagreed
about the only question that matters:

- `share(document, user, viewer)` writes a tuple. `loadActor` loads it, `can()` honours it,
  and the recipient can open the document's page.
- Retrieval does not consult tuples at all. It consults `document_permissions`, which nobody
  could write to.

The result was a live bug rather than merely a gap: sharing a document with somebody left
"I shared it with you" and "the assistant cannot find it" both true, with nothing anywhere
saying so.

## Decision

**The two mechanisms have opposite shapes, and that is why both exist.** A relation tuple is
**additive**: it grants one subject one relation on one object and never takes anything away.
A circulation list is **restrictive**: while any row exists for a document, only the subjects
named may retrieve it. The predicate already in `search.ts` — `NOT EXISTS(any) OR
EXISTS(mine)` — says exactly this, and it is the shape an HR file or a signed contract
actually needs. Neither mechanism can be expressed in terms of the other, so neither is
deleted.

**A list can only ever narrow.** The sensitivity ceiling is a separate condition, ANDed, so
naming a member on the list for a `restricted` document does not let them retrieve it. Rather
than storing a grant that silently does nothing, `grantDocumentAccess` refuses a *role* whose
ceiling is below the document's classification and names the classification as the thing to
change if that is really what is meant. A named *individual* below the ceiling is still
allowed to be added — they may be promoted, or the document reclassified — and the ANDing
means the row cannot widen anything in the meantime.

**Nobody is exempt, including the owner.** An administrator not on the list cannot retrieve
the document and will not see it cited in an answer. This is the surprising part, and it is
what somebody restricting a file to three people means. An administrator who wants it can add
themselves, which leaves a row saying they did — which is a better outcome than a silent
bypass nobody can audit. Opening the document's own page is a different question, governed by
`can()`; this table answers only the retrieval one, and the screen says so.

**Sharing a restricted document adds the recipient to the list.** `share()` calls
`syncShareToAudience` when the object is a document. On an open document it does nothing —
an additive grant on an unrestricted document is exactly what a tuple already means. On a
restricted one the recipient goes on the list, and the audit row records that it happened.
This is the fix for the disagreement, and it is deliberately one-directional: restricting a
document does not revoke anybody's tuples.

**The first grant is a different event from the ones after it.** It is the moment every other
person loses the document, so it audits as `document.restricted` rather than
`document.audience_added`, writes an activity entry, and the interface warns before it rather
than after.

**Reopening is never a side effect.** `revokeDocumentAccess` refuses to remove the last entry,
because doing so would silently return the document to general circulation while looking like
tidying up. `openDocumentToEveryone` is a separate call with its own reason and its own audit
action.

**Every row says why, and who.** The table had `created_by` and nothing else; 0020 adds
`reason` and `granted_by`. A circulation list that cannot explain why anybody is on it is one
nobody will ever prune, which is how these lists rot into "everyone who ever asked".

## Consequences
- Two partial unique indexes rather than one, because casting the role enum to text is only
  `STABLE` and cannot appear in an index expression, and a plain unique index would treat the
  NULL `subject_id` of every role grant as distinct — the exact duplicate being prevented.
- `subject_type = 'team'` remains expressible in the table and unreachable in practice, because
  `teams` and `team_members` are still tables nothing writes. The ACL predicate keeps its team
  clause so that building teams later does not require touching retrieval; until then it is one
  more branch that never matches, and it is named in the README with the rest of the dead
  schema.
- Restricting a document does not retroactively remove memories already formed from it, but it
  does stop them being recalled — memory recall applies the same predicate, so the fact becomes
  invisible to everybody off the list at the same moment the document does.
- A restriction has no expiry. A list is removed by somebody deciding to remove it, not by a
  clock.
- The demo organization now ships one genuinely restricted document, because the difference
  between "classified" and "restricted" is invisible on an empty screen.
