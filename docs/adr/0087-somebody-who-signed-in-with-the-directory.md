# ADR 0087 — Somebody who signed in with the directory

**Status:** accepted · **Date:** 2026-08-24

## Context

The column detector reported `identity_settings.sso_metadata_url` as read by the product and
written by nothing. That reads like a missing field on a form. It was not.

`IdentityProvider` has declared this since Phase 3:

```ts
verifyAssertion(assertion: string): Promise<{ email: string; externalId: string } | null>
```

`MockIdentityProvider` implements it. **Nothing has ever called it.** There is no sign-in with the
directory anywhere in Superwork — so the whole cluster around it decided nothing:

| Column | The screen says | What it did |
|---|---|---|
| `sso_enabled` | "Allow signing in with the directory" | Nothing. There was no sign-in to allow. |
| `jit_provisioning` | "Create people on first sign-in" | Nothing. There was no first sign-in. |
| `sso_metadata_url` | — | Had no writer, because nothing would have read one. |

That is ADR 0084's shape a third time — an abstraction with a mock and no consumer — and the
reason the column looked like a forgotten input rather than a missing feature. `sso_provider` was
the tell: the repository accepted it and the form never sent it, because nobody had ever had a
reason to fill either field in.

## Decision

Build the consumer. `signInWithAssertion` is the only thing in the product that has ever called
`verifyAssertion`, and it is where these three columns start deciding things.

### An assertion says who, never what

The directory is a mirror (§23). It says this person is who they say they are; it says nothing
about what they may do here. The role comes from the membership they already have, or — for
somebody arriving for the first time — from `default_role`, and never from anything the assertion
carried. This is the sentence that makes §23's rule true at the door rather than in a comment.

### Four refusals, and why each one is a refusal

- **The organization has not turned it on.** `sso_enabled` is finally a decision.
- **The domain is not verified.** Without this, anybody a public directory will vouch for — which
  is anybody at all — is a colleague here. `verified_domains` already existed and already gated
  the *sync*; it now gates the door.
- **They are not a member and the organization does not create people on first sign-in.**
  `jit_provisioning` finally has the moment it was named for.
- **Their membership was deactivated.** The directory sync deactivates people who have left
  (§23.2). A sign-in that quietly reactivated them would undo the leaving, so this is named
  separately from "not a member": those two mean opposite things about the same person, and
  telling them apart is the whole point of keeping an inactive row.

### The metadata URL is what makes "enabled" mean something

An assertion is a claim signed by somebody. The metadata URL is where that somebody publishes the
key that signed it. So SSO that is *on* without one is a claim with no source, and `verifyAssertion`
would be trusting whatever arrived.

**SSO cannot be enabled without one**, in the repository *and* in a `CHECK` constraint, because a
pair like this is exactly the kind where one half gets set and the other does not, and the result
reads as working. The URL is checked the way a custom tool's host is (ADR 0050): https only,
because what it points at decides whose signature to trust and plaintext can be rewritten in
transit by the person who benefits; and no private or link-local address, because a URL the server
fetches is a request somebody else chose the destination of.

In `mock` mode nothing fetches it. That is stated rather than hidden: the simulated provider
verifies assertions locally, and what the URL does here is make "single sign-on is on" a claim
with a named source. A live provider fetches it; the column is where it will look.

### The pre-tenant role gets one new read and one new write

`superwork_auth` exists to turn a login into a session and to do nothing else (migration 0008). A
directory sign-in needs two things it has never had:

- **`SELECT` on `identity_settings`**, to know whether this organization takes a directory sign-in
  and from which domains. Read-only: a sign-in changes no setting.
- **`INSERT` on `memberships`**, for just-in-time provisioning — with a policy that is the actual
  guarantee: `role <> 'owner' AND role <> 'admin' AND status = 'active'`.

The repository refuses to *store* `owner` or `admin` as a default role, so the policy says the same
thing twice on purpose. The application check can be edited by anybody who edits the file; the
policy holds even when the row says otherwise. That is the difference between "a stranger with an
assertion cannot become an administrator" as a property of the system and as a property of a
function — and a test proves it by writing `admin` into the row behind the repository's back and
watching the insert fail.

Because a database refusal is not an error message, the sign-in checks the same thing itself and
returns a sentence naming who can fix it. Both paths lead to the same refusal; only one of them
produces a stack trace.

### It does not skip the second factor

A directory assertion proves the first thing. If this person has enrolled a factor here, the
session minted is half-authenticated exactly as a password sign-in's is and resolves to nothing
until the code is given (ADR 0043). Session-minting moved into one `startSession` so that what
follows a password and what follows an assertion are identical because they are the same code, not
because two functions agree today.

### The screen offers it only where somebody accepts it

The sign-in page asks whether any organization has SSO enabled and renders the directory panel only
then. That is what makes the switch visible as a decision: turn it on, and a way in appears; turn
it off, and it goes. A button for a sign-in nobody accepts is the control this product refuses to
render — the same rule the Features screen keeps for inert flags (ADR 0022).

### What `created_by` says about a person who let themselves in

The membership a JIT sign-in creates is `created_by` the person themselves. Nobody added them; they
arrived. A row naming an administrator would answer "who let them in" with somebody who was not
there.

The display name is derived from the address rather than taken from the assertion, because an
attacker-controlled display name is how a "Maya Ellison" who is not her ends up on a task list. The
directory sync corrects it with the real one on its next pass.

## Consequences

- Somebody can sign in with the directory, and an organization can decide who that lets in.
- `sso_metadata_url` has a writer and a meaning; `sso_enabled` and `jit_provisioning` decide
  something for the first time; `sso_provider` is reachable from the screen at last.
- `IdentityProvider.verifyAssertion` has a consumer, which is what makes the contract exercisable.
- `superwork_auth` can read identity settings and insert exactly one shape of membership.
- Detector: **55 → 54**.

## Lesson

A column with no writer is a symptom, and the detector is honest that it cannot say what of. Twice
now the answer has been "the field is missing from a form" and twice it has been "the feature
underneath was never built" — and the two are indistinguishable from the column alone.

What told them apart here was asking the next question down: not *why does nothing write this*, but
*what would read it if something did?* The answer was nothing, and that is a different piece of
work from an input somebody forgot.
