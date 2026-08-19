# ADR 0059 — A rung that only adds

**Status:** accepted · **Date:** 2026-08-19

## Context

ADR 0057 shipped the form that lets somebody write down a call they have just made, and recorded
one thing it had found and deliberately not fixed:

> A **manager** cannot log an interaction. Their role carries `note:*:department`, and a company
> is not in a department, so the scope is not satisfied — while a *member*, who has
> `note:create:org`, can.

The refusal a manager saw was:

> You need **Member** access to create this note. An organization admin can grant it in
> Settings → Members.

That is the product telling an account manager to be demoted. It was worth a decision of its own,
so this is that decision — and the first thing the decision needed was to find out whether it was
one case or a class.

It is a class. Walking every `resource:action` any role list mentions, through four shapes of
resource — owned by the person, in their department, in their team, and filed against nothing —
and asking the real policy engine, **twenty-one** pairs came back where a *higher* rung could do
less than a lower one. They fall into two families, and neither was decided by anybody:

**Ten of them are the manager, and the shape of a company caused all ten.** A manager's grants are
department-scoped where the member baseline is `own` or `org`. `scopeSatisfied('department')` is
`!!resource.departmentId && actor.departmentIds.includes(resource.departmentId)`, so a resource
that belongs to no department can never satisfy it — and a company belongs to no department, nor
does a document the manager is about to create and own, nor a task filed against nothing. So a
manager could not create a document or a knowledge page they would own, could not update one, and
could not log a call, in every case because the member baseline reached further down than the
manager's did.

**Eleven of them are the administrator, and a missing word caused all eleven.** The admin list
never mentions `milestone`. `*:read:org` covers reading it and nothing else, so `milestone:create`,
`milestone:update`, `milestone:complete` and eight more verbs were something a manager could do in
their department and an administrator could not do at all.

This is what four independently maintained lists look like after eleven increments of edits. Each
line was defensible when it was written; the relationship between the lists was never stated
anywhere, so nothing was checking it.

## Decision

**The ladder is composed, not remembered.** `viewer`, `member`, `manager` and `admin` are now each
written as what they *add* to the rung below:

```ts
const VIEWER  = [ … ]
const MEMBER  = compose(VIEWER,  [ … ])
const MANAGER = compose(MEMBER,  [ … ])
const ADMIN   = compose(MANAGER, [ … ])
```

A member is a viewer who does the work. A manager is a member with a department. An administrator
is a manager whose department is the organization. `owner` stays `*:*:org`, which is the whole
ladder by definition. The invariant is now a property of how the lists are built rather than
something four separate edits have to keep agreeing about.

**`milestone:*:org` is added to the administrator explicitly.** Composition alone would have given
an admin the manager's *department*-scoped milestone grants, which is the wrong shape: an
administrator who happens to be in no department would still have been refused. Saying it at org
scope is what was meant all along.

**The invariant is a test, not a comment.** `tests/permissions/role-ladder.test.ts` rebuilds the
catalogue from the role tables themselves — wildcards expanded against every resource and action
seen anywhere, so a new resource is covered the day it is added — walks it through the four
resource shapes, and refuses any pair that is allowed at one rung and refused at the next. It also
asserts the lists are prefixes of each other, so somebody rewriting them as four lists again fails
before the behavioural walk even runs. Undoing the composition fails three of its seven tests and
names all twelve manager breaks by hand.

**`guest` and `service` are not on the ladder, and the code says why.** A guest is somebody from
outside invited to one team: their grants are team-scoped and narrow by design, and one of them —
`note:create:team` — is something a viewer deliberately does not have, because a viewer is the
role that means "look, do not write". The two are sideways from each other rather than above and
below. A service actor starts with nothing and is given exactly what it needs (ADR 0055). Both are
excluded from the test, and both say so where the lists are, so the next reader does not have to
guess whether it was an oversight.

## What this does not do

It does not widen any role against *nothing* — only against each other. A viewer still creates no
tasks, a member still cannot update a company, and a manager still has no reach into settings; the
test asserts all three, so a future "fix" that widens by deleting a rung fails.

It does not touch `ROLE_MAX_SENSITIVITY`. Clearance is a separate ceiling, it is already monotonic
along the ladder, and a permission a role holds is still checked against what that role may read.

`project:update:department` left the manager list. It was covered by `project:*:department` on the
line above it, and a grant stated twice is a grant that can be edited in one place and not the
other. The test now refuses a repeated grant in any list.

## Consequences

- Sarah Lindqvist, an Account Manager in the demo, can write down the call she just made. The
  browser check signs in as her and does it, and asserts she is not told to become a member.
- An administrator can create and move a milestone.
- Twenty-one refusals that nobody chose are gone, and the twenty-second cannot be introduced
  without a red test that names it.
- The `Settings → Members` exceptions from ADR 0055 stay what they are for: a capability one
  person needs, not a workaround for a rung that took something away.
