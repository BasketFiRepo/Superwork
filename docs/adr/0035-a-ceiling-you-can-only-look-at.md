# ADR 0035 — A ceiling you can only look at

**Status:** accepted · **Date:** 2026-08-15

## Context
Two rows decide how far this product may go, and neither could be changed without editing
the database.

**`monitoring_policies`** holds the organization's own limits on how hard the system may
chase its people: the contacts-per-person-per-day budget, and the no-surprises window
somebody gets to answer before anything about them goes past them. Both were displayed on
two screens. The budget was enforced. **The window was not**: `scheduleLadder` read
`PROFILES[…].noSurprisesReviewHours` — the jurisdiction constant — so an organization that
gave its people longer than its jurisdiction requires would have seen its own number on the
screen and had the shorter one applied.

**`agent_permissions`** is the ceiling on what any agent may do, and it had two hollow
columns. `asAgent` filtered for `effect = 'allow'` and dropped the rest, so a **deny row had
never denied anything**. `max_sensitivity` sat on every row and was never read, so the
clearance ceiling it describes did not exist.

Worse, the column named `tool_pattern` holds a *permission* pattern: `matchesGrant` splits on
`:` and compares the halves to the resource and the verb. The seed wrote tool names —
`draft_email`, `create_task` — which parse as a resource nothing is called and therefore
matched nothing at all. Since a non-empty grant list means "only what is listed", the only
row that has ever covered anything is the `*`. Four of the five seeded lines were decoration.

And the agent's own refusal reads: *"An admin can add it in Settings → AI governance."* That
screen listed the grants and had no control on it — the same defect as the spend cap in
ADR 0030, where a refusal pointed at a setting that did not exist.

## Decision

**An organization may tighten what its jurisdiction allows, never loosen it.** Fewer contacts
a day; a longer window to answer. Asking for more contacts than the profile allows, or a
shorter window than it requires, is **refused with the number that stopped it** rather than
silently clamped — a setting that quietly disagrees with the screen has stopped being a
control. The same rule as an approval policy (ADR 0026) and a spend cap (ADR 0030).

**The window is enforced from the resolved answer**, `max(profile, organization)`, in the
place that actually decides whether a rung goes past somebody. The refusal says which of the
two numbers stopped it and, when it is the organization's, that it is longer than the
profile requires.

**Deny beats allow, and is checked before the grant list exists.** An organization with no
allow rows has not configured a ceiling; a deny row is a decision somebody made and it bites
either way. That is the only rule under which writing one down is worth doing.

**The clearance ceiling is the lowest line that applies**, intersected with what the agent
asks for. A ceiling a caller's argument can raise is not a ceiling.

**Changing what agents may do asks for the password again** (§4.1). It decides what every
agent in the company may do; the moment to check that the admin is still at the keyboard is
before the change. Tightening the monitoring policy does not ask, because that direction only
ever protects somebody.

**The prohibited five stay prohibited.** Individual scoring, keystroke and screen capture,
covert monitoring, automated employment decisions and reading private messages are refused by
a check constraint, and the screen says so rather than showing five switches that are stuck
off. There is no setting; there is a constraint, and the test asserts the constraint rather
than the sentence.

## Consequences
- The seeded grants are rewritten to permission patterns in the migration rather than left
  looking like policy. No CHECK enforces the shape: a malformed row now appears on a screen
  where somebody can fix it, and a constraint that rejected an existing row would take the
  migration down with it.
- `tool_pattern` keeps its name. Renaming a column with live data to fix a documentation
  problem is churn; the validator, the screen label ("resource and verb") and this record say
  what it holds.
- An organization with no `monitoring_policies` row now resolves to exactly what its
  jurisdiction requires, rather than to the column defaults. The two were the same by
  coincidence.
- `nudgeBudget` and the ladder read the same resolved numbers, so the screen, the refusal and
  the behaviour cannot disagree.
- The AI-governance screen is now walked by the browser check, which it never was.
