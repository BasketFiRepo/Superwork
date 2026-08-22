# ADR 0076 — Correspondence the product can record

**Status:** accepted · **Date:** 2026-08-22

## Context

The only `INSERT INTO conversations` or `INSERT INTO messages` in this repository was in the seed.
Fourteen columns across the two tables were read by the product and written by nothing in it —
the largest single entry the coverage detector has ever had, and one fact underneath all of it:
**the correspondence record was a fixture.** Every thread in the demo was put there by
`seedThreads`, and a real customer signing in tomorrow would have an inbox that could never
contain anything.

Reading the code for *why* turned up the sharper half. Superwork already sends email: a draft is
approved, `email_sends` holds it for its recall window, and the worker dispatches it. On success
the worker set `sent_at`, wrote an activity — and never appended a message to the thread.

So the customer's message stayed the last one in it. `last_direction` stayed `inbound`,
`last_message_at` stayed at their message, and the `pastSla` test in `SELECT_CONVERSATION` went on
counting a reply we had already sent as one we still owed. **The inbox chased threads it had
itself answered.** That is not a missing feature; it is the product telling somebody something
untrue about work they did.

## Decision

**A reply that goes out lands in the thread it answers.** Written in the worker at the moment the
provider accepts it, not where the send is queued — a recalled message never reaches that line,
and never appears in the record as correspondence that happened. The sender is the draft's author,
because that is who it actually came from.

**Correspondence that arrived another way can be written down.** Build rule three says the whole
product runs with zero external credentials, so the answer to "the inbox is a fixture" is not an
IMAP client. It is `recordMessage`: paste the email a customer sent to somebody's own address, the
reply they wrote from their phone, the message that arrived while the integration did not exist.
A thread can be started from one, or a message appended to an existing one.

**Trust is derived, never declared.** `direction` decides it and the caller cannot pass it —
there is no `trustLevel` on the input type, on the Zod schema, or in the SQL. Anything inbound is
`untrusted_external`, which is what makes `listMessages` run the injection scan over it. A field
the caller could set would be a way to paste an instruction into the product and ask for it to be
marked safe, and no interface should be able to ask for that (§5.9).

**The thread's clock belongs to the database.** `last_message_at` and `last_direction` are
recomputed from the messages by `sw_conversation_last_message`, so neither the recorder nor the
worker can get them wrong, and they cannot disagree. Recomputed rather than moved forward, so a
message filed by mistake and withdrawn leaves the clock right rather than pointing at a message
that is no longer there. `internal` messages count: a thread that went quiet because we only
talked to ourselves is one the queue should still show.

**Where a thread is filed is named, or derived from the address — never read out of the body.**
Retrieved content may never determine where something goes. The fallback is the domain rule the
CRM already uses for inbound mail, which associates to a company that exists and never creates one.

**A member can record.** They have been able to log a call since the ladder was built, and this is
the same act. A product where only a manager can file the email a customer sent them is one where
it stays in that person's mailbox, which is the state this whole subsystem exists to end. So
`conversation:create:org` joins the member baseline, and the ladder composes it upward.

## `trust_level` is a vocabulary now

It has been `text NOT NULL DEFAULT 'untrusted_external'` since 0003, with the vocabulary living
only in `packages/ai`'s `TrustLevel` type. That was survivable while the seed was the sole writer.
It stops being survivable the moment the product writes it, because of this line:

```ts
const findings = row.trust_level === 'untrusted_external' ? detectInjection(row.body_text) : []
```

A value outside the vocabulary is not a data-quality problem. It reads as "not untrusted", and the
injection scan over content from outside the company is **silently skipped**. A typo would buy an
attacker exactly what `transcript-injection.test.ts` exists to prevent. The CHECK lists all four
values from `TrustLevel` rather than the two this table uses, because a constraint that quietly
disagreed with the shared type would be a second vocabulary — which is the thing being fixed.

`conversations.channel` deliberately did **not** get the same treatment. Its only honest value
today is `email`, and a CHECK listing one value reads to the detector as a pin — which inverts it,
so a product write to a pinned column is a red build. The vocabulary lives in
`CONVERSATION_CHANNELS` beside the writer until there is a second value to put in it. A call or a
meeting is not a thread: it is an interaction, and `logInteraction` is where it goes.

## Consequences

- The inbox stops chasing threads that have been answered — the SLA clock now moves when the
  reply goes out.
- A person can file what actually reached them, and the record is theirs rather than the seed's.
- Fourteen columns leave the detector's queue at once: **91 → 77**, and readings **33 → 19**.
- One test had to be corrected first. It grepped the API route for the word `trustLevel` and
  failed on the comment explaining there isn't one. It now sends the field anyway — past the
  schema, past the types — and asserts the stored row is still `untrusted_external` and still
  flagged. Behaviour, not text.
