# ADR 0023 — A share only ever adds

**Status:** accepted · **Date:** 2026-08-15

## Context
`share`, `unshare`, `listShares` and `sharedWith` were written for Phase 4 and reachable
from nothing but the acceptance loops — no route, no screen. A person could not share
anything, could not see what had been shared with them, and could not revoke a share once
a loop had made one.

That is the `purgeDocument` shape from ADR 0016 — a finished subsystem with no way in — and
by the time it was found, two later features had shipped on top of it. Circulation lists
union tuples into retrieval (ADR 0019) and the scoped task list unions shared rows into a
narrow role's view (ADR 0021). **Both had a branch no user could populate.**

Reading the module to build the interface turned up three defects underneath.

## Decision

**A share is additive and specific, and the interface says so.** It grants one subject one
relation on one object and changes nobody's role. That is deliberately different from the
two neighbouring mechanisms it is easy to confuse it with — a circulation list *narrows* who
may reach a document, and a team is a standing group with membership. Only one of the three
takes access away, so the panel states which.

**You can only share what you already hold.** The existing rule, kept: the grant is checked
against the granter's own permission on the object with the verb the relation implies, so a
tuple can never manufacture reach. A member who cannot update a task cannot make somebody
else its editor.

**A task is shareable.** It was missing from `ShareableType` while `listTasks` already
unioned `sharedObjectIds(actor, 'task')` into its scope predicate — a branch I added in ADR
0021 that could never match. Sharing one task with one colleague is the most ordinary act of
collaboration there is, and its absence made live code dead.

**`sharedWith` is self only.** It guarded on `member:read`, which *every* role holds down to
`guest`, so any colleague could list what somebody else had been given. Its neighbours —
`personalRecord` and `listDisclosures` — are self-only even for administrators, and this
view renders on the same screen. Nothing is lost by closing it: an administrator reviewing
access reads it from the object end with `listShares`, where the same facts live and the
permission is the object's own.

**"Why can I see this?" includes what reaches you through a team or department.**
`sharedWith` listed only tuples naming the person directly, while `loadActor` has always
resolved all three subject types when it builds the relation set. Answering with a third of
the truth is worse than not answering: somebody sees an object they cannot account for, which
is the exact confusion the view exists to end. Each row now says whether it reached them by
name, through a team, or through a department.

**An expired share is shown, not hidden.** `loadActor` and `sharedWith` both filter on
`expires_at`, so a lapsed grant stops working immediately — but `listShares` presented it as
live. It is now marked and kept: *"they lost it on Tuesday"* is the question somebody is
actually asking, and a filter would have thrown the answer away. Revocation is a soft delete
for the same reason.

**Every share list resolves the object's own name.** A list showing `document` and a uuid is
a list nobody can act on, and the question being answered is "what did I give them".

## Consequences
- Two branches that could not be populated now can: a shared document joins the circulation
  list it would otherwise be excluded from, and a shared task appears for a role whose scope
  would not have reached it. Both were already tested with tuples created by test fixtures;
  they are now reachable by a person.
- The share panel is on tasks and documents. Projects, companies and knowledge spaces are
  shareable in the type and have no panel yet — named in the README rather than left to be
  discovered.
- Expiry is enforced at read time by `loadActor` filtering the tuple out. Nothing sweeps
  expired rows, and nothing needs to: they stop counting the moment they lapse, and keeping
  them is what makes the history answerable.
- `sharedWith` closing to self means there is no single screen showing every grant in the
  organization. That is a real gap for an access review, and the object-by-object view is the
  honest substitute until somebody needs the roll-up enough to justify the permission it
  would require.
