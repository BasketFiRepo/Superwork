# ADR 0022 — A switch that changes nothing

**Status:** accepted · **Date:** 2026-08-15

## Context
`feature_flag_overrides` is the last of the tables nothing wrote to, and the odd one out
among them, because the **read path was already finished**. `apps/web/src/lib/session.ts`
loads this table on every request, separates the organization-wide rows from the per-user
ones, and layers them over `DEFAULT_FLAGS`. That code has run on every page load since
Phase 0 and has never found a row.

The failure was therefore quiet rather than broken: every organization has had exactly the
same features, and no administrator could change one. The flags are not decoration — the
sidebar renders a navigation item as a disabled *"Soon"* when its flag is off — so what was
missing was the ability to turn anything off or on at all.

Surveying what the flags actually gate turned up a second problem. Of the ten declared
flags, four (`reports`, `autopilot`, `chat_presence`, `public_api`) are read by nothing
whatsoever, and two more (`insights`, `compact_density`) were declared and unwired despite
having an obvious place to attach.

## Decision

**Three layers, shown as three layers.** Default → organization → person, resolved on every
request. The screen shows which layer a value came from and why, rather than a single toggle
that mysteriously disagrees with what somebody set.

**A person's own choice sits on top of the organization's.** An organization turning
something off does *not* stop somebody turning it back on for themselves. That is correct
for a preference and wrong for a capability — which is the reason to state it out loud:
anything that governs what a tenant *may* do belongs in the policy engine or a plan limit,
never in a switch a person can flip for themselves. The flag set is for preferences and
staged rollout, and the ordering is what enforces that distinction.

**Reading takes no permission; changing the organization layer does.** The session already
computes every one of these values for every signed-in person on every request — that is
what decides which navigation items they see. Requiring `settings:read` in `flagStates`
meant a member could not discover why a screen was missing, or set their own row height,
while the same values were being computed for them one layer down. The first version of this
did require it, and the test pack caught it immediately.

**A personal preference is not audited.** Turning a feature off for a whole organization is
a governance event and writes an audit row with a reason. Somebody choosing their own row
height is not, and filling the trail with those would bury the ones that matter.

**An unknown flag name is refused twice.** The repository refuses it with a sentence; the
database refuses it with a `CHECK` listing every valid name. The list is duplicated from
`packages/config/src/flags.ts` on purpose — the database is where a typo has to be stopped,
because the resolver simply layers unknown keys onto an object nobody reads, so a misspelled
override would sit there for ever looking as though it did something. A test asserts the two
lists agree, so they cannot drift.

**A flag that controls nothing gets no switch.** `reports`, `autopilot`, `chat_presence` and
`public_api` are listed on the screen as declared-but-inert, with no toggle. Offering one
would be a control that changes nothing, which is worse than an absent control: somebody
will use it and believe it worked. Listing them rather than hiding them means nobody goes
hunting for the screen they are named after.

**Two flags were wired rather than left inert.** `insights` now gates its navigation entry
like its four siblings. `compact_density` now sets `data-density` on the application shell,
which the design tokens have supported since Phase 0 — it is the one genuinely per-person
flag, and it makes the person layer visible in the interface rather than only in a test.

## Consequences
- The density selector moved from `:root[data-density]` to a bare `[data-density]` attribute
  selector, because only the root layout can render `<html>` and the flag is resolved inside
  the signed-in shell. Custom properties inherit, so a wrapper works.
- The demo organization ships with **no** overrides. Every other increment seeded its table,
  but seeding one here means turning a feature off in the demo, and degrading the demo to
  populate a screen is the wrong trade. "Nobody has changed anything" is the honest state,
  and the layering is exercised by the test pack, the Phase 5 loop and the browser check.
- Six flags now control something and four still do not. That ratio is visible on the screen
  rather than buried, which is the point: the inert four are a to-do list in public.
- `listTasks` composes the scope predicate from ADR 0021 beside the status array, the search
  term and the cursor. A stale server briefly made that look like a parameter-binding bug; it
  was not, but the combination is now asserted for both a broad and a narrow scope, because
  when nested-fragment binding does go wrong it goes wrong as a malformed array literal at
  runtime rather than at compile time.
