# ADR 0024 — A container lends a read, never a say

**Status:** accepted · **Date:** 2026-08-15

## Context
ADR 0023 put a share panel on tasks and documents, and named projects, companies and
knowledge spaces as shareable in the type with no panel yet. Projects had no detail page at
all to put one on — only a list.

Building the page turned the shape of the problem up. A project tuple grants `project:read`
through `can()`, which opens the project. The tasks inside it are separate rows with their
own scope, so a share of the project reached the page and nothing on it: *"I shared the
project with you"* and *"you can see none of its work"* would both have been true. That is
the hole circulation lists had before ADR 0023, in a new place — and it would have shipped
looking like it worked.

Reading the neighbouring code for the panel turned up three more defects underneath.

## Decision

**A share of a container reaches what the container holds, for reading only.** `Resource`
gained `containers`, and `relationGrant` accepts a relation on a container when — and only
when — the verb is `read`. `listTasks` unions the tasks of shared projects into its scope
predicate; `getTask` passes the task's project as its container, so the list and the page
agree.

**Read only, whatever relation the tuple carries.** Not even `owner` on a project lends
`update` on a task inside it. A container share is coarse in a way a row share is not: the
set of rows inside changes daily, and the granter cannot see what they are handing over. So
it lends the ability to look. Write access is granted on the row itself, where the person
granting it can see what it is.

**A container you cannot open lends nothing inside it.** The acceptance loop found this, not
the test pack: a project classified above the recipient stayed shut while its tasks — which
carry no classification of their own — opened anyway. A locked door with the window left
ajar. The container descriptor now carries the container's own classification and is skipped
when it is above the reader's ceiling, in `can()` and in the list predicate both, from one
exported `readCeiling(actor)` so the two cannot drift.

**The project list is a permission check, not just RLS.** It was a raw query on the page
gated on `organization_id` alone — right for every role whose grant is organization-wide and
wrong for the two that are narrower. A `guest` holds `project:read:team` and saw every
project in the company. It is now `listProjects`, the same shape as tasks and documents.
Classification is per row and cannot ride in a scope predicate, so a project above the
reader's ceiling is dropped from the list rather than listed and then refused on open.

**You can always take back what you gave.** `unshare` required `update` on the object. A
member holds `project:read` and can therefore share a project as a viewer — and then could
not undo it. A grant you cannot withdraw is worse than one you cannot make. The granter can
always revoke their own tuple; revoking only ever narrows, so this cannot widen anybody's
access. Each row now says whether *this* reader may revoke it, and the button is disabled
with the reason when they may not.

**The panel offers only the relations the person could actually grant.** It offered all four
to everybody, so a member could choose "can change it", fill the form in, and be refused on
submit. `shareableRelations` asks the same question against the same table before the
control is drawn.

**A document's team was declared and never selected.** `DocumentView` has `teamId` and
`SELECT_DOC` never fetched it, so it arrived `undefined`: the team-scoped list matched on
`d.team_id` and then `getDocument` passed an empty `teamIds` and refused the very row the
list had just shown. Listing a thing that will not open is worse than not listing it.

## Consequences
- The project page carries the work as well as the panel. A page you can be given access to
  and learn nothing from is not worth sharing, and its task list is `listTasks` — the same
  scope-aware read as the tasks screen — which is what makes the container rule real rather
  than a claim in a comment.
- `containers` is a general mechanism with exactly one caller today. Documents and meetings
  belong to things too; they are not wired up, because a rule with one use is easier to
  reason about than one with four and no test pack for three of them.
- Sharing a project does not add anybody to a circulation list. A shared *document* joins
  one (ADR 0023) because retrieval consults the list; a project has no such list, so a
  restricted document inside a shared project stays restricted. That is the intended answer,
  and it means "shared the project" and "the assistant can cite everything in it" are
  different statements.
- The share panels for companies and knowledge spaces are still absent. Both are in
  `ShareableType`; neither has a detail page with a panel on it.
- Nothing sweeps the tuples of a deleted project. They are soft-deleted with everything else
  and stop resolving because the object is gone, which is the same answer sharing gives for
  every other object.
