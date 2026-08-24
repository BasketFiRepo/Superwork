# ADR 0084 — A mailbox somebody connected

**Status:** accepted · **Date:** 2026-08-24

## Context

`EmailProvider` declares three methods. `send` and `recall` are used everywhere. The third:

```ts
sync(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string | null }>
```

`MockEmailProvider.sync()` implemented it, and **nothing in the product had ever called it.** The
`InboundMessage` type was referenced by exactly one file: the mock that produced it.

That one gap explained the whole remaining dead-column cluster. `email_accounts` had nine columns
nothing wrote — `user_id`, `address`, `provider`, `status`, `scopes`, `sync_cursor`, `last_sync_at`,
`last_error`, `token_expires_at` — which is precisely the state a sync loop needs, down to the
cursor and the error field. `messages.external_id` and `conversations.external_id` were dead too,
and they are exactly what an inbound message carries for dedupe and threading.

Meanwhile the inbox is fully built and was fed **by hand**: ADR 0076 added `recordCorrespondence`
so a person could type in an email they had already received.

So *abstractions before integrations* was half-honoured. The abstraction was designed and the mock
was written; the consumer never was. Nothing here needs a credential — the mock is the point.

## Why the consumer was never written

The mock's `sync` returned an empty list, with a comment explaining that the demo's inbound mail
was seeded straight into `messages`.

**A mock that cannot produce an inbound message makes its own consumer untestable.** Anybody
writing the sync loop would have had nothing to prove it worked against, so nobody wrote it, and
nine columns stayed empty for a year. The mock now holds a queue, hands it over once, and advances
the cursor — the same shape a real provider has, with nothing leaving the machine.

That is the first thing this ADR is about: a first-class mock (§13.2) is not one that implements
the interface, it is one you can build the consumer against.

## Decision

**A person connects their own mailbox and nobody else's.**

This is the whole privacy posture, and it is enforced the way `personalRecord` enforces its own:
the owner is always the caller, `myMailboxes` filters on `actor.userId` in SQL, and the API has no
field for whose it is. An administrator who could connect a colleague's mailbox would be operating
the surveillance switch §29.5 exists to make unbuildable — it would put every message that person
receives into a system their manager can search, without them ever agreeing to it.

`email_accounts.user_id` was **nullable**, which would have allowed an organization-wide connection
owned by nobody. It is NOT NULL now, and a trigger requires the owner to be an active member here —
the fifth writing of that rule, because a foreign key to `users` reaches every tenant.

**The screen split follows the same line.** Your own mailboxes live on your personal record, with
the address and the state. Settings shows an administrator **two numbers**: how many are collecting
and how many have stopped. Never whose, never which address. A test reads that panel and asserts it
renders no per-mailbox value at all.

**A stopped connection has to say what stopped it.** `email_accounts_trouble_is_explained` refuses
any status but `connected` without a message. A mailbox that quietly stopped syncing, showing an
inbox going stale, is the classic integration lie — and `status`/`last_error` had been sitting
there to prevent it since 0010.

The worker distinguishes the failures §5.6 already names. A `TransientError` is this minute's
problem: the mailbox stays connected and the next pass tries again. An `AuthError` needs the person
to reconnect, so the mailbox says `expired` and shows why. Treating them alike either nags somebody
about a hiccup or leaves a dead connection looking healthy.

**Threading is on the provider's thread id, never the subject.** Subject matching is how two
unrelated conversations called "Re: invoice" become one thread and a customer sees somebody else's
reply quoted back at them.

**Dedupe is a unique index, not a SELECT first.** Two sync passes racing after a crash would both
find nothing and both insert. The insert says `ON CONFLICT DO NOTHING` and counts what it did not
write.

**The cursor advances only after what came with it is filed.** A cursor moved first and a crash
second is mail nobody will ever be offered again.

**Disconnecting stops the collection and keeps what arrived.** Those are business records on threads
colleagues have been working; deleting them because somebody unplugged a mailbox would lose the
account history with it. Erasure is the route that removes a person's correspondence, and it goes
through the retention machinery with a reason attached.

Inbound content is `untrusted_external` on the way in. That is ADR 0076's rule and is not
re-litigated here — it is why the personal record's copy says plainly that what arrives is never
allowed to instruct the assistant.

## Two mistakes the tests caught, both mine

**A hand-rolled permission check.** `mailboxHealth` first compared `actor.role` to `'admin'`
directly. §4.2 has one authorization function and three consumers on purpose: a check written out
by hand is one the ladder cannot be reasoned about from, and one an ADR 0055 exception would
silently not reach. It goes through `can()` now.

**Two source-reading assertions that matched my own prose.** One asserted the API route contains no
`userId` and matched the *comment explaining why there is no such field*. The other asserted the
admin panel never says "address" and matched its own copy promising that it shows none. Exactly the
trap ADR 0080's detector fell into — reading the explanation of a defect as the defect. Both now
assert on the code: the Zod schema's fields, and whether the panel renders any per-mailbox value.

## Consequences

- The inbox can be fed by a provider instead of by hand, with no credential anywhere.
- `email_accounts` gains writers for eight of its nine columns; `messages.external_id` and
  `conversations.external_id` gain both a writer and a unique index. Detector: **70 → 60**, the
  largest single move this instrument has produced.
- **`token_expires_at` deliberately still has none.** It holds an OAuth token's expiry, and a
  provider that needs no credential has no token to expire — the mock signals an expired
  connection by raising, which the worker turns into `status = 'expired'` with the message
  attached. Writing a date there from a mock would be inventing a fact to satisfy a detector.
  It is the one column here that genuinely waits for a real provider.
- A person can see that their own mailbox stopped, and why, on the screen that is about them.
- An administrator can see that *some* mailbox stopped, and cannot see whose.
- `@superwork/integrations` is aliased in `vitest.config.ts` — the first test to reach for a
  provider directly, because the mock is what makes the contract exercisable.

## Lesson

The column detector found nine empty columns on `email_accounts` and I read them, for a long time,
as *an integration nobody had built*. They were not. They were **one unwritten function**, and the
reason it was unwritten was that the mock could not produce the thing it consumed.

A dead column can be a missing feature. A cluster of dead columns that all describe the same
subsystem is usually a missing *caller* — and the thing to look for is not the feature, it is
whatever made writing it impossible to verify.
