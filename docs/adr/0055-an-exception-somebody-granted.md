# ADR 0055 — An exception somebody granted

**Status:** accepted · **Date:** 2026-08-19

## Context
`checkHumanPermissions` decides every `can()` call in the product, and it has always begun:

```ts
const grants = [...ROLE_PERMISSIONS[actor.role], ...actor.extraPermissions]
```

`loadActor` selected `memberships.extra_permissions` on every request and handed it over.
**Nothing has ever written it.** The permission model had an escape hatch designed into the
function that decides everything, and no door to it: an administrator who needed to give one
person one extra capability had to change their role, which hands them everything else that role
carries.

The column is why it could not be filled honestly. It is a bare `text[]`, and an exception needs
to say who granted it, why, and until when. A permanent, unattributed exception is not an
exception; it is a quiet promotion.

## Decision

**The grant becomes a row, and the array goes.** `permission_grants` holds one capability, for
one person, with its granter, its reason, its expiry and its revocation. `loadActor` reads live
grants directly rather than from a column kept in step with them — because that is what makes an
expiry *exact*. A permission that lingers until a sweep runs is a permission that outlives its
reason, and a nightly job is not an access-control mechanism.

The extra subquery costs nothing measurable: the permission check stayed at 3.6ms p95 against its
10ms budget, measured by the loadtest before and after.

Leaving the array beside the table would have been two places to disagree about what somebody may
do, which is the one thing a permission model cannot afford. So it is dropped, and the down
migration restores it empty — rolling back cannot recover exceptions it is also dropping the
record of, and inventing entries would be worse than an organization noticing they are gone.

**What keeps an exception an exception:**

- **You cannot give away what you do not have.** Refused unless the granter could perform it
  themselves, at that reach or wider. Without this, the ability to open the door is a way to mint
  capability out of nothing — an admin who cannot change billing could grant themselves a deputy
  who can.
- **Not a wildcard.** `*:*:org` is not an exception; it is making somebody an owner without
  saying so. Refused in the repository with that sentence, and again by a CHECK, so no other
  writer can do it either.
- **Not something the role already carries**, at that reach or wider. That is not an exception —
  it is a row that will still be there, unreviewed, after the role changes.
- **Not a string the engine would silently skip.** The engine's loop does `catch { continue }` on
  a malformed grant, which was harmless while nothing could write one and would be a control that
  appears to work the moment somebody can. Refused with a sentence in the application, and by
  `sw_grantable_permission` in the database.
- **At most a year.** Longer than that is a role, not an exception, and nobody reviews what never
  comes up. No end date at all is allowed and is written out on the screen as "No end date"
  rather than left blank.

**Granting asks for a fresh proof of identity; taking one back does not.** The direction rule
(ADRs 0044, 0046, 0050). Removing a capability in a hurry — because somebody has left the team,
or the reason has gone — is exactly the case that should be easy.

**The person it is about is told, at the same time.** A `disclosure` notification, which is the
one kind that cannot be turned down (ADR 0047), on both the grant and the revocation. Nothing
about a person reaches anybody before it reaches them (§29.3), and a capability somebody did not
ask for is exactly that.

**The decision says which of the two allowed it.** `can()` used to answer "Allowed by your admin
role" whatever the source. Once exceptions exist, that hides the thing a reader most needs to
see, so an exception says so.

## What the prohibited capabilities are not

§29.5 lists what must be impossible to configure — productivity scoring, covert monitoring,
keystroke and screen capture, automated employment decisions, reading private messages. None of
them is reachable through this door: they are columns on `monitoring_policies`, not permission
strings, and no `resource:action:scope` grants any of them. The coverage list keeps reporting
those columns as read-and-never-written, and that is the guarantee working, not a gap.

## What is deliberately not built

**A picker of known permissions.** The field takes a typed string, validated in two places, and
the refusal names the format. A dropdown built from `ROLE_PERMISSIONS` would look friendlier and
would quietly become the list of permissions that exist — which is not the same list, and would
go stale the first time a resource was added.

**Granting to a team or department.** That is a role, and roles already exist. An exception is
for a person.

**Approval for a grant.** It already needs an administrator, a proven identity, a written reason,
and it tells the subject. Routing it through the approvals queue as well would be friction on the
one path that is already the most watched in the product.

## Consequences
- Nobody has to be made an administrator to be given one thing.
- `memberships.extra_permissions` is gone; `packages/db/src/types.ts` no longer declares it.
- Fourteen tests, four of which are ceilings. Removing the expiry filter from `loadActor` fails
  four of them; removing "you cannot give away what you do not have" fails one.
- The acceptance loop grants a real exception to a real member, watches the engine change its
  answer, and takes it back.
