# ADR 0061 — How far a thread may travel

**Status:** accepted · **Date:** 2026-08-19

## Context

Nine tables carry a `sensitivity` column: `documents`, `document_chunks`, `companies`,
`contacts`, `conversations`, `messages`, `notes`, `tasks`, `projects`. Three of them mean
something. Documents are classified by a classifier, corrected by a person, attributed, cascaded
to their passages and filtered on in retrieval (ADRs 0041, 0044). Companies and contacts are
classified when somebody adds one and filtered on the relationship view (ADR 0056).

The other five have carried `internal` since Phase 0 with nothing writing them. The column
detector reported that much. What it could not see is worse, and only reading the code showed it:
**nothing reads them either.** `checkClearance` is the function that compares a resource's
classification against the reader's ceiling, and it only ever sees what a repository puts into
the `Resource` it checks. No repository put `conversations.sensitivity` there. So the column
decided nothing at all — not who could open a thread, not whose inbox it appeared in, not what
the agent could read out of it.

The policy engine said so itself, and was wrong about the reason:

```
// ... every unclassified resource — tasks, projects and notes have no
// classification column at all — above the guest ceiling of `public`.
```

They all have one. That comment is why nobody looked again.

What that adds up to: every member holds `conversation:read:org`, `listConversations` gated on an
organization-level resource with no per-row test, and the inbox listed every thread in the
company to everybody in it. A thread carrying a customer's unagreed pricing, or something
somebody said in confidence, could not be marked as anything else — and the control that looked
like it would do that had never been wired to anything.

## Decision

**The correspondence is the unit that gets classified, and it is a thread.** `conversations`
gains the same attribution shape documents have had since ADR 0041 — `sensitivity_source`,
`sensitivity_set_by`, `sensitivity_set_at`, `sensitivity_reason` — with one addition: a third
source, `unset`.

`unset` is the state every existing thread is in, and it earns its place. `internal` on a row
nobody weighed is a default, not a decision, and a screen that cannot tell the two apart teaches
people that everything has been reviewed. The database keeps that honest:
`conversations_unset_is_default` refuses a row that claims no decision and carries a level anyway,
so `unset` means the default wherever it is read.

**A message is as classified as the thread it is in, and the database keeps that true.** The
alternative is classifying each message, and it is worse: a thread marked confidential with one
message still marked internal is a leak that reads as a rounding error, and every caller that
writes a message would have to remember to look the thread up. `messages.sensitivity` is derived
by trigger on insert and on update, and a thread's classification cascades to the messages
already in it — the same decision ADR 0044 made for a document and its passages, for the same
reason: when two places must agree, the agreement is not something application code should be
trusted to remember.

**The new level is checked, not the old one.** `classifyConversation` asks `can()` about the row
*as it will be*, so a manager filing a thread `restricted` is refused by the policy engine
measuring their own ceiling — in its own words, rather than in a second copy of the rule in the
repository (ADRs 0045, 0056).

**Lowering asks for the password; raising never does.** Raising narrows who can read the thread.
Lowering widens it, and cascades to every message already sent. That is the direction rule this
codebase has applied five times now (ADRs 0044, 0046, 0050, 0054, 0055).

**The enforcement is everywhere the content goes, not only where it is opened.** A classification
that only stops the detail page is decoration:

- `listConversations` filters by the reader's ceiling. A subject is content — the same argument
  the relationship view already makes about a `restricted` contract's title.
- `inboxCounts` takes an actor and filters too, as does the sidebar badge. A badge that counts a
  thread somebody cannot open tells them it is there.
- `getConversation` puts the classification into the resource, and answers **404 rather than
  403** when the refusal is about clearance. A refusal that distinguishes "not allowed" from "not
  here" tells the reader the thread exists (§3.2's rule, applied inside one tenant).
- `read_conversation@v1` filters on the caller's ceiling, so the agent facet is capped where the
  principal is. §4.2 asks for a check at the API *and* tool layers; the inbox repository is not
  on the tool's path.
- The stale-thread watcher and the follow-up composer both surface a message excerpt, and both
  now stop at the ceiling. `ground.ts` reads message bodies for injection scanning, and takes its
  thread list from the watcher — so it is covered by that one.

## What this deliberately does not do

**`notes`, `tasks` and `projects` are left alone**, and not for tidiness. Every one of those rows
carries `internal` today. Start passing that into `can()` and the guest ceiling of `public`
refuses all of them — which is exactly the regression the clearance change was written to undo,
and the reason that comment existed at all. Making those three real means deciding what an
unclassified task is, and that is a decision of its own rather than a consequence of this one.
The corrected comment in `policy.ts` now says which tables are wired and which are not, so the
next person reads the state rather than a claim about the schema.

**No activity feed entry.** Who can read a thread is not news to the people who can no longer
read it, and the feed is a place they would still see the subject. It is audited instead.

**The `unset_is_default` constraint is `NOT VALID`**, for the reason ADR 0054 recorded: the down
migration drops the attribution and leaves `sensitivity` where it is, so re-applying over a
database where somebody had classified a thread would meet a row whose justification the rollback
had thrown away. It holds for every write from here.

## Consequences

- A thread can be classified, from the thread, with a reason, by somebody whose clearance reaches
  the level they are choosing — and the panel says who a level actually reaches, in the roles
  this product has, rather than only what it is called.
- A classified thread leaves a member's list, their counts, their direct open, and the agent's
  read of it.
- Seventeen tests, ten browser beats. Removing the ceiling filter fails two of the tests; the
  browser walk classifies a thread as the owner, fails to find it as a member, and puts the demo
  back through the control that asks for the password.
- The detector's queue drops from 108 to 105. Three of the nine tables that carry a
  classification — `notes`, `tasks`, `projects` — remain unwired, and this says which and why.
