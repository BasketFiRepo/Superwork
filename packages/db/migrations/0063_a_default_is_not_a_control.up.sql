-- 0063 — A default is not a control.
--
-- Three columns the detector reports as "read by the product, written by nothing in it". For
-- each of them the answer is not to build a writer. It is to make the safe value the only value.
--
-- `monitoring_policies` already works this way: five columns whose CHECK pins them to false, so
-- the detector lists them under "pinned by a constraint (can hold one value, so having no writer
-- is the guarantee)" rather than as work outstanding. That is the strongest statement this schema
-- makes — a control that can be switched off is not one — and these three were relying on a
-- DEFAULT to say the same thing.
--
-- A DEFAULT is a suggestion. It decides what happens when nobody says otherwise, and says nothing
-- at all about what happens when somebody does. Anything holding a connection can write the other
-- value, and in each case here the other value is the unsafe one:
--
--   * `custom_tools.reversible` — the column's own migration says "a custom tool has no inverse
--     Superwork can construct, so it is never reversible", and then defends that with DEFAULT
--     false. `gate.ts` reads it to decide what an agent may do unattended, so a true here buys an
--     external HTTP call the undo path cannot take back — while the run's card says it can.
--
--   * `agent_simulations.simulated` — a dry run recording that it was not one. The whole value of
--     a simulation is that nothing it describes happened.
--
--   * `meetings.recording_consent_required` — §12.5 requires per-meeting acknowledgement before a
--     transcript may be attached, and `consentState()` short-circuits to satisfied the moment this
--     is false. Turning it off does not skip a formality; it skips the consent regime.
--
-- All three are widenings, and the direction rule says a widening asks for a fresh proof. There is
-- no proof that would make a custom tool undoable, so there should be no way to claim it.
--
-- Validated rather than NOT VALID, because every row in every database already holds the safe
-- value — nothing has ever written any of them, which is how they reached the detector's list.

-- The jurisdictional dial is `recording_consent_mode` (all_parties | one_party), which stays
-- settable. What is pinned is that consent is needed at all.
ALTER TABLE meetings
  ADD CONSTRAINT meetings_consent_always_required
    CHECK (recording_consent_required = true);

ALTER TABLE agent_simulations
  ADD CONSTRAINT agent_simulations_always_simulated
    CHECK (simulated = true);

ALTER TABLE custom_tools
  ADD CONSTRAINT custom_tools_never_reversible
    CHECK (reversible = false);
