# ADR 0029 — An invitation is a credential

**Status:** accepted · **Date:** 2026-08-15

## Context
`invitations` was created in migration 0001 and never read *or* written. The consequence was
the largest single gap in the product: **there was no way to add a person to an organization**
except by running the seed or connecting a directory sync. A product whose first act is
"invite your colleagues" could not do it.

The table was close to right. It already had `token_hash`, `expires_at` and `accepted_at`,
which is the correct shape. What it lacked was everything about the invitation's *life* —
who it was for, why, who withdrew it, and which user it eventually became — and the index on
the one column anybody would ever look it up by.

## Decision

**An invitation is a credential, so it is built like one.** The token is random, stored as a
SHA-256 hash, and returned exactly once — from the call that created it. There is no screen
that can show it again because the database does not have it, and the interface says so on
the panel rather than letting somebody discover it by coming back tomorrow. Same contract as
an API key.

**Nothing is emailed.** No provider in this product calls out of the process, so claiming a
message was sent would be the fake integration button §25 forbids. The link is handed over
with "delivering this is your job" written next to it.

**You cannot invite somebody to a role above your own.** An admin inviting an owner is a
privilege escalation with a friendly form on it. This is the membership form of "you can
only share what you already hold" (ADR 0023), and the API's enum omits `owner` entirely — an
organization gets its owner when it is created, not by invitation.

**A bad token, a used one and a lapsed one are indistinguishable.** The accept page says the
same nothing to all three. Telling them apart tells somebody probing which addresses have
been invited.

**One live invitation per address**, by partial unique index. Two outstanding invitations for
the same person is two different roles racing each other, and whichever link they happen to
open decides.

**Accepting claims the row before it creates the membership**, so two tabs opening the same
link cannot both succeed — `accepted_at IS NULL` is part of the `UPDATE ... RETURNING`, and
an empty return means somebody else won.

**A withdrawn invitation is kept, not deleted.** "Who invited that contractor and who called
it off" is a question an access review asks.

**Accepting signs them in.** An invitation that ends at a login form has made somebody type
their new password twice for no reason.

## Consequences
- Two defects came out of the same root. The unique index on `users` is
  `lower(email) WHERE deleted_at IS NULL` — a partial expression index — so `ON CONFLICT
  (email)` matches no constraint and raises. `applyDirectorySync` had exactly that, which
  means **re-syncing a directory threw whenever a person already existed**. Both now name
  the expression and repeat the predicate.
- The expiry rule is a `BEFORE INSERT` trigger rather than a `CHECK`. A CHECK fires on
  UPDATE too, which would block expiring an invitation early — a softer withdrawal an
  administrator should be able to make. The constraint I wrote first did exactly that and
  the test pack caught it.
- Seats are still not enforced. `plan_limits.seats` and `subscriptions.seats_purchased` are
  both unread, and an invitation is the obvious place a seat check belongs — but what
  happens at the limit (refuse, warn, allow with overage) is a product decision rather than
  a technical one, and inventing an answer here would be worse than the honest gap.
- Members can be invited and listed but not edited from this screen. Changing somebody's
  role or deactivating them still lives in Identity with the directory sync.
