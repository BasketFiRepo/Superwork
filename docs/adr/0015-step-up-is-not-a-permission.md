# ADR 0015 — Step-up is not a permission

**Status:** accepted · **Date:** 2026-08-14

## Context
Since Phase 3 the AI-governance screen has told people that publishing an agent, or granting
it high-risk capability, "requires a second approver and step-up authentication". Half of
that was true: change control has refused to let the requester approve their own change
since it was written, and there is a test for it.

Step-up authentication was never built. The interface described a control the product did
not have — which is worse than not having it, because somebody reads the sentence and stops
worrying.

The threat it addresses is not a weak password. It is a **session**: an unlocked laptop, a
cookie lifted off a machine, a tab left open in a shared room. Every existing control assumes
the session belongs to the person named on it, and for the handful of irreversible actions
that assumption is worth re-checking.

## Decision

**Step-up is a separate question from permission, and it stays separate.** `can()` answers
"may this person do this at all" — synchronously, from data loaded once with the actor,
inside a 10 ms budget. Step-up answers "is the person who may do it still the one at the
keyboard". Folding the second into the first would make a clean, cacheable decision depend
on the freshness of a cookie, for the sake of four call sites.

**It is enforced in the repository, beside the permission check.** `assertSteppedUp(actor,
action)` sits next to `can()` in `decideChange`, `rollbackAgent`, `activateCustomTool` and
`reviewHost`. A rule the API layer asks for politely is not a control — some other caller
will arrive.

**Freshness lives on the session row, not in a token.** `sessions.stepped_up_at` is an
instant, checked in code against a five-minute window. Storing a boolean would let one
step-up be spent and then relied on for the rest of a fortnight-long session. Returning a
token would put the decision in the browser.

**Signing in is not a step-up.** `login` sets `steppedUpAt: null` explicitly. They are
proofs about different moments; treating a login as a step-up makes the first action after
one free, which is the unlocked-laptop case exactly.

**It belongs to one session, not to the person.** Confirming in one tab does not confirm in
another. The context carries it (`TenantContext.steppedUpAt`) because it is a property of
*this request*; `loadActor` copies it onto the actor only when the actor being loaded is the
one making the request.

**An agent can never satisfy it.** `assertSteppedUp` refuses any non-user actor before it
looks at the timestamp — even one handed a fresh one. An agent has no keyboard to be sitting
at, and the change-control path exists for precisely the case where an agent's configuration
needs to change.

**A stolen session must not become a password oracle.** Five failures lock that session out
of stepping up for fifteen minutes. The lock is narrow on purpose: the session keeps
everything it could already do, so an attacker gains nothing from it and a colleague who
mistyped loses only the irreversible actions.

**`StepUpRequiredError` is distinct from a refusal.** The caller can fix it by proving who
they are, and the interface has to say so — showing "not permitted" to somebody who *is*
permitted is a lie about why they were stopped. It answers 401 with a flag the client reads.

**Confirming carries out the action.** The client holds the call, asks the question, and
replays it, resolving the original promise only when the action has actually run. The first
version resolved as soon as the prompt appeared; the confirmed action then ran without the
screen noticing, and the browser check caught it.

**The proof is stamped on every audit row the session writes**, from the context rather than
an argument. It records a fact about the request — was this person recently re-verified when
they did this — rather than an interpretation of which rule applied, and a column cannot be
forgotten the way an argument can.

## Consequences
- Five call sites now require a password that did not before. Every test and acceptance loop
  that drives those admin flows had to say so, which is the point: the requirement is visible
  in the harness, not implicit.
- The Phase 3 loop's self-approval check was strengthened on the way past. It caught *any*
  error, so it would have kept passing if the self-approval rule were deleted and step-up
  refused instead. It now asserts each rule by its own message.
- The window is five minutes and the lockout is fifteen. Both are constants in
  `packages/core/src/step-up.ts` and `packages/auth/src/session.ts`; neither is configurable
  per organization, because an organization that could set the window to a year would.
- Password re-entry is the only factor. A deployment with SSO or WebAuthn would want those
  instead; the seam is `stepUp()`, which is the one place that decides what counts as proof.
