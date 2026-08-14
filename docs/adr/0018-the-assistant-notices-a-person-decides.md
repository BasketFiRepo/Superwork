# ADR 0018 — The assistant notices, a person decides

**Status:** accepted · **Date:** 2026-08-14

## Context
`memory_facts` has existed since migration 0006 with a complete design — scope,
subject/predicate/object, confidence, a `candidate → confirmed → superseded → forgotten`
state machine, `supersedes_id`, `conflict_flagged`, validity dates, `confirmed_by`,
`source_run_id`, `source_citation` — and nothing has ever written a row to it.

Two live code paths read it. `deleteDocument` counts the memories a deletion will forget,
and `purgeDocument` forgets them. Both have been reporting zero about an empty table since
Phase 1, which means §25.13 — "deleting a document must delete its chunks, embeddings and
memories" — has been satisfied the way an empty set satisfies anything. The README's promise
that deleting a document takes "any memories the assistant formed from it" was written by me
two increments ago and was, at the time, vacuous.

The reason this is worth building rather than deleting is that an assistant that cannot
remember re-derives the same answer from the same document every time, and an assistant that
remembers badly is worse than one that does not remember at all. The whole design question
is which of those you get.

## Decision

**Nothing is remembered without a source.** Every fact carries the document passage it came
from, and the constraint is in the database: a fact that is not forgotten must have a
`source_citation` with a `documentId` and an `anchor`. A remembered fact is a claim somebody
can open and disagree with, which is the only thing that separates it from a rumour the
system repeats confidently.

**The source is resolved, never taken.** A proposal names a passage *by its index into the
run's own grounding*, and `proposeMemories` looks it up. A model that invents a document id
cannot store one; a model that cites a passage the run never retrieved is refused with a
reason rather than stored at lower confidence. This is the same discipline as "no model
output reaches the database as SQL", applied to provenance.

**Nothing is recalled until a person agrees.** A candidate is what the assistant noticed; a
confirmed fact is what somebody stood behind. Only confirmed facts are recalled, `confirmed_by`
is NOT NULL by constraint, and `confirmMemory` refuses a non-user actor outright. An assistant
that could promote its own observation would be deciding what the company believes — and the
failure mode is not a wrong answer once, it is one wrong inference quietly becoming the
foundation of every later answer, discovered months afterwards with no way to tell which
conclusions rested on it.

**Recall is bound by the permissions of the source.** A memory is a compressed quotation, so
recalling one is disclosing its source in fewer words. The predicate in `recallMemories` is
deliberately the same shape as the ACL in `hybridSearch` — sensitivity ceiling, plus
`document_permissions` when the document carries explicit grants — and it is applied to the
document the citation points at, because the memory row has no sensitivity of its own to be
wrong about. Without this, the memory table is a hole straight through document permissions:
the retrieval layer would refuse you a passage while the assistant recited its conclusion.

**Two confirmed answers to the same question are unstorable.** A partial unique index permits
one confirmed fact per subject and predicate within a scope. Changing what is known is
therefore necessarily a supersession: the old row is closed off with a `valid_to`, the new one
points back at it with `supersedes_id`, and "what did we think last quarter, and who changed
it" stays a question with an answer. Flagging contradictions and reconciling them later would
mean the interesting window — the one where the assistant holds two beliefs — is exactly the
window nothing prevents it from acting on.

**A contradiction is surfaced, not resolved.** A candidate that disagrees with a confirmed
fact is stored with `conflict_flagged` and shown beside what it contradicts. Confirming it
directly is refused, and the refusal names the path that is open: correct the existing fact,
which keeps both answers and the name of whoever changed their mind.

**Forgetting is a state, not a delete.** A forgotten fact stops being recalled and stays on
the record until retention takes it, because "we used to believe this and stopped" is a
question somebody will ask about an answer the assistant gave last month.

**Volatile facts say how old they are.** A fact proposed as volatile — anything with a figure,
a currency or a duration in it — is recalled with the date it was agreed, and past 90 days it
is marked as worth checking again rather than silently retired. Quoting last spring's number
as though it were checked this morning is the specific way a memory system starts lying.

## Consequences
- Confirmed facts are never purged by age. Only forgotten and superseded ones are, under a new
  `memories` retention class. Ageing out current knowledge would make the assistant quietly
  know less, on a schedule nobody would connect to the symptom.
- A memory scoped to one person is deleted on erasure, not anonymised. The document it came
  from stays and anybody can read it again; what goes is the assistant's standing conclusion
  about that individual.
- The mock brain proposes facts by deterministic rule — only sentences it is already citing,
  only ones that read as a plain declarative statement, never from a superseded passage, and
  confidence capped at 0.8 because a regex match is not evidence of certainty. A live model
  fills the same shape and is refused by the same checks, so neither is trusted with the
  source.
- Two people can open the memory screen and see different lists. That is correct and will look
  like a bug to somebody one day; the screen says what it is scoped by.
- Extraction is only as good as the rule. Facts that are not phrased as "X is Y" are not
  noticed at all, which is a real limitation named in the README rather than papered over with
  a cleverer regex.
- `agent_messages`, `email_accounts`, `events`, `ingestion_jobs`, `invitations`, `saved_views`
  and `task_watchers` remain tables nothing reads or writes. They are dead schema rather than
  dead code, and are listed in the README so the next person does not have to rediscover them.
