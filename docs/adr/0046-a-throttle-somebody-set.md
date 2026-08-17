# ADR 0046 — A throttle somebody set

**Status:** accepted · **Date:** 2026-08-17

## Context
`workflows.max_concurrent_runs` and `workflows.daily_action_cap` have existed since migration
0007. Nothing has ever written either one.

Unlike most of the columns this work has been finding, these two are not decorative: both are
read on every firing and both are **enforced**. A workflow with unfinished runs does not queue
another, and one that has reached its cap is skipped for the rest of the day. So every workflow
in every organization has run under the column defaults — 1 and 100 — chosen by a migration for
nobody in particular, and correct for nobody in particular.

The skip message says so out loud:

> *Skipped: it has already done 47 things today and its cap is 100. **Raise the cap if that is
> too low** — it is a number somebody set, not a failure.*

Nobody set it. Nobody could raise it. This is the same defect as the spend cap in ADR 0030 and
the agent grants in ADR 0035: a refusal pointing at a control that does not exist.

## Decision

**Both numbers are settable, together, with a reason.** They are one decision — how hard this
automation may run — and splitting them into two controls would invite changing one while
looking at the other's consequence.

**Raising asks for a fresh proof; lowering never does.** Raising either number widens what runs
with nobody watching: more work queued at once, or more actions in a day. That is the
irreversible direction, because the actions have happened by the time anybody reviews them.
Lowering only ever narrows, and a control that asks for a password to make something *safer*
teaches people to click through the prompt. `workflow.throttle` joins `STEP_UP_ACTIONS`, the
same shape as `document.declassify` (ADR 0044).

**There is no "unlimited".** The bounds are 1–50 runs at once and 1–10,000 actions a day,
refused in the repository with the numbers in the message and again by a CHECK constraint, so
no writer can express "no limit". An automation that acts without a person watching has a
ceiling by design; a text field that accepts 1,000,000 is a ceiling somebody has removed
without noticing they removed it.

**A number somebody chose names them and says why.** `limits_set_by`, `limits_set_at` and
`limits_reason`, with a CHECK that a named decision carries a reason — the attribution pattern
from ADR 0044. A workflow still on the defaults names nobody, and the panel says exactly that:
*"Nobody has chosen these."* An unattributed default and a deliberate choice of the same number
are different facts, and a governance review needs to tell them apart.

**Admins and owners, not the workflow's own owner.** The permission is `workflow:update`, which
managers do not hold — they can create, simulate and activate. The throttle is the ceiling on
what activation *means*, so it sits with the people who set the other ceilings (ADR 0035)
rather than with the person whose automation is being held back by it. That is a real cost: the
owner who reads "raise the cap if that is too low" has to ask somebody. The alternative is that
the person with the most reason to want a higher cap is the one who sets it.

**The counting moved to the repository.** `checkCapacity` lived in the executor. The screen
that offers to change a limit has to show what that limit is doing right now — how many runs
are unfinished, how many actions have been taken today — and two places counting "what has it
done today" would eventually disagree about the only thing that matters. One function, called
by the scheduler and by the page, so the number on the screen is the number that will be
enforced.

## What is deliberately not built

**An organization-wide default for new workflows.** The migration's 1 and 100 remain the
starting point. A default that an admin sets is a second number that has to be reconciled with
the per-workflow one, and the honest version of that feature is a policy, not a field.

**A cap on cost rather than on actions.** Actions are what these two columns count and what the
scheduler enforces; spend already has its own ceiling with its own enforcement (ADR 0030).
Adding a per-workflow cost cap here would put two unrelated limits behind one control.

## Consequences
- The panel sits on the workflow page and shows both numbers beside what they are doing today,
  read from SQL rather than restated in prose.
- A person without `workflow:update` sees the panel, the numbers and a disabled button with the
  policy engine's own sentence — the state is worth seeing even when the control is not yours.
- `POST /api/workflows/[id]` answers through the one error mapper, because a step-up has to
  reach the screen as a step-up rather than as a flat refusal.
- `checkCapacity` and `Capacity` now come from `@superwork/core`; the agent package re-exports
  nothing of its own for them.
