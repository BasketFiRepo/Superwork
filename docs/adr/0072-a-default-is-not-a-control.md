# ADR 0072 — A default is not a control

**Status:** accepted · **Date:** 2026-08-21

## Context

Three columns sat on the detector's queue as *read by the product, written by nothing in it*:
`custom_tools.reversible`, `agent_simulations.simulated`, and
`meetings.recording_consent_required`. Every previous increment answered that report by building
the writer the interface implied. Here that would have been wrong three times over.

Each column already holds the value it should hold, and holds it because of a `DEFAULT`. A
`DEFAULT` decides what happens when nobody says otherwise. It says nothing at all about what
happens when somebody does — anything holding a connection can write the other value, and in each
case the other value is the unsafe one:

- **`custom_tools.reversible`** — the column's own migration comment says *"a custom tool has no
  inverse Superwork can construct, so it is never reversible"*, and then defends that claim with
  `DEFAULT false`. `gate.ts` reads it to decide what an agent may do unattended. A `true` here
  buys an external HTTP call the undo path cannot take back, while the run's card says it can.
- **`agent_simulations.simulated`** — a dry run recording that it was not one. The entire value of
  a simulation is that nothing it describes happened.
- **`meetings.recording_consent_required`** — §12.5 requires per-meeting acknowledgement before a
  transcript may be attached, and `consentState()` short-circuits to satisfied the moment this is
  false. Turning it off does not skip a formality; it skips the consent regime.

## Decision

**Pin all three with a CHECK.** `monitoring_policies` has worked this way since the beginning:
five columns whose constraint holds them at `false`, which is why the detector lists them under
*pinned by a constraint — can hold one value, so having no writer is the guarantee* rather than as
work outstanding. That list is the strongest statement this schema makes, and these three were
relying on a suggestion to make it.

**Every one of these is a widening**, and the direction rule says a widening asks for a fresh
proof. There is no proof that would make a custom tool undoable, so there should be no way to
claim it. Narrowing is the direction that never needs one, and none of these three narrow anything.

**The dial beside the pin still turns.** `recording_consent_mode` (`all_parties` | `one_party`)
stays settable, because *which* parties must consent is a jurisdiction question with real answers
on both sides. What is pinned is that consent is needed at all. A pin that swallowed the dial
would be the mirror of the mistake: an unconfigurable product rather than an unbreakable rule.

**Validated, not `NOT VALID`.** Every row in every database already holds the safe value —
nothing has ever written any of them, which is precisely how they reached the detector's list.

**And the product says the rule it keeps.** The custom-tool form now states that nothing built
there can be undone, that there is no setting for it, and why an agent needs a person's approval
to make one of those calls. A rule enforced and unstated reads to the person configuring it as an
oversight.

## Consequences

- Three columns move from the work queue to *pinned by a constraint*, which is the honest place
  for them: **97 → 94**.
- The tests write through `adminSql()` — the owner connection, the most privileged writer there
  is — because a rule only the repository layer keeps is a rule anything holding a connection can
  break.
- One test asserts the detector *sees* the pins, by running its own `pinnedColumns()` over the
  live constraint definitions. If a future constraint were written in a shape the parser does not
  recognise, these three would quietly return to the queue and somebody would eventually build
  the writer.
