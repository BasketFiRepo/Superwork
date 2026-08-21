# ADR 0068 — An agent somebody still stands behind

**Status:** accepted · **Date:** 2026-08-21

## Context

`agents.recertified_at` has existed since migration 0006. Nothing has ever written it. It is
selected **twice** — into `AgentPersona`, and again by the AI-governance screen's own query —
and rendered nowhere. A column the interface fetches and drops is the exact shape that caused
the `documents.team_id` bug: the list matched on it and the detail view refused the very row the
list had just shown.

What it was for is the control this product otherwise has no version of.

Publishing an agent is well built: one person proposes a change, **another** approves it, the
approver re-enters their password, the request is refused if the agent moved underneath it, and
`agent_versions` records both names. All of that happens when something *changes*. Nothing
happens when nothing changes — so an agent granted `email:send` and `restricted` reading in
March is still holding them in December, and the only record is a publication nine months old.
Capability accumulates and is never re-examined, which is the failure access reviews exist for.

## Decision

**Publishing recertifies.** `decideChange` stamps the attestation when it approves: two people
have just read this configuration and one signed it off with a fresh password, which is exactly
what recertification asserts. Recording it there is what stops the column becoming a second,
parallel record that drifts from the one the approval flow already keeps — and it means a
company that publishes regularly never sees an overdue agent, which is correct.

**`recertifyAgent` is the act publishing cannot express**: an agent that has not changed, read
and vouched for anyway. Step-up, because re-attesting a capability is the same weight as
granting one — the catalogue calls it *"saying an agent may still do everything it may do"* —
and a note, because the difference between a review and a click is whether anything was written
down. `assertSteppedUp` also refuses an agent actor by name, so an assistant cannot vouch for
its own capability without a second rule being written.

**The attestation names a configuration, not a date.** `recertified_version` records the
ordinal that was read, so republishing makes it stale the same day rather than at the end of the
interval, and a refusal can say *which* version somebody actually looked at.

**How often is the organization's number**, beside the other things it decides about how its
assistant behaves — the nudge budget and the no-surprises window — rather than a constant.
90 days by default, bounded 7–365 in the database and in words: an interval of three days is a
review nobody performs, and one of ten years reads like a control and behaves like nothing.

**A stale attestation costs autopilot, and nothing else.** The mode ceiling drops one rung, the
run says which review is outstanding on its own timeline, and everything short of unattended
running goes on working. Blocking a stale agent outright would be a policy this product does not
get to invent on an organization's behalf. Withholding the one mode whose whole premise is that
somebody signed off recently is the same rule stated where it bites — and because the ceiling is
decided per run rather than written to the row, recertifying restores it without anybody editing
the agent.

## The version I first anchored on was the wrong one

`agents.version` looked like the configuration version. It is a row counter the touch trigger
increments on **every** write, including the recertification's own — the first test failed with
`recertified_version` 1 against `currentVersion` 2 for that reason.

It would also have been wrong in a way no test I had written would have caught: pausing an agent
for the weekend bumps `version`, so a fortnight's pause would have invalidated an attestation,
and pausing *narrows* what an agent may do. The direction rule this codebase lives by says
narrowing never asks for a fresh proof.

The right anchor is `agent_versions.ordinal` — the published configuration, 0 for an agent that
has never been through the approval flow. `CertifiableAgent.publishedVersion` says so and says
why, so the next person to reach for `agents.version` finds the reason already written down.

## What this deliberately does not do

**It does not require a second person.** Publishing does, because publishing changes something.
An access review is the owner attesting, and in a company with one administrator any other rule
would mean nobody could ever perform one. What the record carries is *who*, so a reviewer
reading the trail can see when an agent has only ever been vouched for by the person who runs
it — which is a judgement for them, not a refusal for us.

**It does not pause agents automatically.** A sweep that suspended overdue agents would be a
policy decision with real operational consequences, made by us rather than by the organization.
The state is surfaced on the two screens that already claimed to show it, and the one capability
it withholds is the one that runs with nobody watching.

## Consequences

- The agent inventory on the AI-governance screen has a column for the thing it has been
  fetching and discarding since Phase 2: *"Maya Ellison · 2026-08-21 · never reviewed ·
  overdue by 110d"*.
- The demo seeds all three states — one agent reviewed recently, one never, one reviewed 200
  days ago — so the screen shows what the control is for rather than a wall of green.
- `agents.recertified_at` comes off the detector's queue, and the three columns added beside it
  and the interval are all written: **101 → 100**.
