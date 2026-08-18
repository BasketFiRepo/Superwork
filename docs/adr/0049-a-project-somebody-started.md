# ADR 0049 — A project somebody started

**Status:** accepted · **Date:** 2026-08-18

## Context
`projects` has been read on every screen since Phase 1 — the list, the health score, the
classification a task inherits from the project it is on, the roster that lends a read of it
(ADR 0032), the milestones filed against it (ADR 0048) — and **written by the seed alone**.

There is no `createProject` anywhere in the product. A company using Superwork could work on
exactly the projects a demo fixture happened to invent, and every feature built on top of them
described somebody else's work. It was found while building ADR 0048, named there rather than
folded in, and this is it.

## Decision

**The create is asked about the project that is about to exist.** Its owner and its department
go on the resource, so a `project:create:department` grant means what the role table says it
means — the lesson of ADR 0045, applied before it could be repeated.

**Nobody starts a project they could not then open.** A `restricted` project started by somebody
who reads up to `confidential` would vanish from their own list the moment they made it, and
take its tasks' classification with it. Refused with the ceiling named, the same rule as filing
a document (ADR 0045) and reclassifying one (ADR 0044). The form disables the levels above the
person's reach rather than letting them find out afterwards.

**Two open projects do not share a name.** People refer to a project by name in a sentence —
"put it on the Halden one" — and two live ones make that sentence ambiguous to a colleague and
to the assistant. A partial unique index enforces it for open projects only, so a name is free
again once the project holding it is completed or cancelled: "Q1 finance close" comes round
every year, and refusing it for ever would be a rule about the wrong thing.

**A target date is not before the start**, by CHECK constraint. The health score reads both, and
a project whose target precedes its start makes every number computed from them meaningless
rather than visibly wrong.

**Creating something with no way to close it is half a feature**, so `setProjectStatus` ships in
the same increment. A project list that can only grow is one people stop reading, and "which of
these are we actually doing" stops having an answer. The rule mirrors a milestone's (ADR 0048):
`completed` is a claim about the work and is refused while tasks or milestones are still open,
naming what is left; `cancelled` is a decision about the project and is always available.

**The owner is on the roster by trigger, not by this repository remembering.** ADR 0032 already
syncs `projects.owner_id` onto `project_members`; creation gets it for free, and a second writer
would be a second thing to keep in step.

## What is deliberately not built

**`projects.key`.** The column exists, the seed leaves it null everywhere, and nothing reads
it — not even `ProjectView`. Populating it would be inventing a convention with no consumer,
which is the thing this work exists to remove. It stays on the dead-column list, named here.

**Renaming, re-owning and re-scoping a project.** The status is the field that makes creation
survivable; the rest is an edit surface with its own questions (what happens to the roster when
the owner changes, what happens to task classification when the project's changes) and deserves
its own increment rather than being bundled in.

**Creating a project through the agent.** `create_task` exists as a tool; `create_project` does
not, and starting a project is a commitment with an owner and a budget of somebody's attention.
When there is a reason for the assistant to propose one, it can go through the approval gate
like everything else.

## Consequences
- The projects screen offers the control to the people whose grant covers it and explains the
  refusal to everybody else, in the policy engine's own words.
- The project page gains a status panel that states both rules — refused while open, cancellable
  always — before anybody presses anything.
- `POST /api/projects` and `POST /api/projects/[id]/status` answer through the one error mapper,
  so a refusal is 403 and a rule is 400 with the sentence that says why.
- The demo is unchanged: the loop starts a project, closes it, reuses the freed name and removes
  both, so the seeded six are still the six.
