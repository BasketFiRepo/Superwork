# ADR 0043 — A password is not the only thing that opens the door

**Status:** accepted · **Date:** 2026-08-17

## Context
`users.mfa_enabled` has existed since migration 0001 and nothing has ever written to it or read
it. There was no second factor anywhere in the product.

Worse than the missing feature was what it left in place. **Step-up authentication — the gate in
front of every irreversible action (§4.1) — re-asked for the same password the session was opened
with.** Its own doc comment says it "defends against a session rather than a password: a laptop
left open, a cookie lifted from a machine". Against exactly those cases, asking for the password
again defends very little: whoever lifted the cookie usually has the password too, and whoever
is at the open laptop needs nothing. The boolean that was supposed to make that better had never
been true for anybody.

## Decision

**TOTP, verified in-process.** RFC 6238, HMAC-SHA1, thirty-second steps, six digits. Same
reasoning as every other external dependency having a working mock: the whole product runs with
no credentials and no network, and a TOTP secret is checked offline against a standard every
authenticator app already implements — a real second factor rather than a placeholder for one.
The implementation is verified against the published test vectors, because a TOTP that is subtly
wrong is a lockout for everybody who enrols. WebAuthn belongs behind an `IdentityProvider` when
one exists; it needs an origin-bound browser ceremony that cannot be honestly simulated.

**Enrolment is two steps, and the database enforces it.** Generating a secret turns nothing on.
It is turned on by proving a code from it — the only evidence that the person can read the thing
they will be asked for from now on. A CHECK constraint refuses `mfa_enabled` without a confirmed
secret, so no writer can produce an account that demands a code nobody can supply. A one-step
enrolment is a lockout waiting for the first typo, and a lockout is worse than the risk.

**Step-up asks for the factor, not the password, once somebody has one.** Otherwise the factor
guards signing in and not the irreversible actions, which is the wrong way round. This is the
reason to build it at all.

**The half-authenticated session is a row.** `sessions.mfa_satisfied_at` is null until the code
is given. `resolveSession` refuses such a row — no screen, no API, no actor — and one narrow
read, `resolvePendingSession`, can see only whose code to ask for. Holding that state in a row
rather than in memory means it expires with everything else and can be revoked like anything
else.

**The lockout is the session's, not the account's.** Five wrong codes pause that browser for
fifteen minutes, sharing the counter step-up already uses. An account-wide lockout would let
anybody with an email address lock the real person out of their own sign-in.

**A used code cannot be reused inside its own window.** Thirty seconds is thirty seconds in which
a shoulder-surfer or a proxy can replay it. The accepted step is stored and the verifier refuses
to go backwards, which makes each code single-use without a cache to keep in step. The visible
cost is real: immediately after using a code you must wait for the next one. That is the correct
trade and every authenticator flow makes it.

**Recovery codes are shown once and stored as hashes**, removed as they are used — single use is
the storage rather than a flag somebody has to remember to clear.

**Turning it off asks for the factor.** A session alone is not enough: the whole point is that a
session might not be the person, and removal is the one action that would make every other
action free again.

**A factor is the person's own.** There is no user id in the API. An administrator cannot enrol,
read or remove somebody else's — an admin who could take it off would be a way around it.

## What is deliberately not built
**An organization-wide requirement.** `require_mfa` would be the natural next column, and the
question it raises is what happens to the people who have not enrolled: refusing their sign-in
locks a company out of its own operations software, and refusing only their step-up actions is a
weaker claim than the setting appears to make. That is a decision about somebody's business, not
a detail to guess at. The per-person factor is complete and useful on its own, and this is named
here rather than left to be discovered.

## Consequences
- Enrolment is offered on the personal record, beside the rest of what the person controls about
  themselves.
- Erasure clears the secret and the recovery hashes, and lists them in its inventory — a secret
  only one person holds cannot mean anything once they are gone.
- `mfa_secret` and `mfa_recovery_hashes` join `SENSITIVE_FIELDS` for `user`, so no generic field
  read can carry them.
- `verifyFactor` and the callers around it take an optional `now`, the seam the nudge ladder
  already has: a test or a loop names the moment it means rather than waiting thirty seconds for
  a clock (ADR 0039 made the same point about reminders).
- The demo owner still signs in with a password. The loop enrols, proves, spends a recovery code
  and turns it off again, putting the demo back — the README's sign-in instructions stay true.
