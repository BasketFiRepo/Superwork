-- 0060 — An agent somebody still stands behind.
--
-- `agents.recertified_at` has existed since migration 0006 and nothing has ever written it.
-- It is selected twice — into `AgentPersona`, and again by the AI-governance screen's own
-- query — and rendered nowhere. A column the interface fetches and drops is the shape that
-- caused the `documents.team_id` bug: the list matched on it and the detail view refused the
-- very row the list had just shown.
--
-- What it was for is the control this product otherwise has no version of. Publishing an agent
-- takes two people and a step-up: one proposes, another approves, and `agent_versions` records
-- both. That happens when something *changes*. Nothing happens when nothing changes — so an
-- agent granted `email:send` and `restricted` reading in March is still holding them in
-- December, and the only record is a publication nine months old. Capability accumulates and
-- is never re-examined, which is the failure access reviews exist for.
--
-- Recertification is the other half: a named person saying "I have read what this may do, and
-- it is still right", against a configuration that is named rather than implied.

ALTER TABLE agents
  ADD COLUMN recertified_by      uuid REFERENCES users(id),
  -- The version ordinal that was read. Without it "recertified in March" is a date attached to
  -- nothing — the agent may have been republished twice since, and the attestation would be
  -- about a configuration that no longer exists.
  ADD COLUMN recertified_version integer,
  ADD COLUMN recertification_note text;

-- All four, or none. A date with no name is a claim that somebody reviewed this without saying
-- who, and a name with no version is a claim about a configuration nobody can identify.
--
-- NOT VALID, for the reason 0054, 0056 and 0057 recorded: the down migration drops three of the
-- four columns and leaves `recertified_at` where it is, so re-applying over a database where an
-- agent had been recertified would meet a row this cannot be made true of. It holds for every
-- write from here.
ALTER TABLE agents
  ADD CONSTRAINT agents_recertification_attributed
    CHECK (
      (recertified_at IS NULL AND recertified_by IS NULL
        AND recertified_version IS NULL AND recertification_note IS NULL)
      OR (recertified_at IS NOT NULL AND recertified_by IS NOT NULL
        AND recertified_version IS NOT NULL AND recertification_note IS NOT NULL)
    ) NOT VALID;

/**
 * The person who stands behind an agent is a member of the organization that runs it.
 *
 * The guarantee 0056, 0057, 0058 and 0059 each make in their own way: a foreign key to `users`
 * says the person exists and nothing about which tenant they are in. An attestation signed by
 * somebody this organization cannot see is worse than none — it looks like a control.
 */
CREATE OR REPLACE FUNCTION sw_agent_recertifier_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = NEW.recertified_by AND organization_id = NEW.organization_id
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'an agent can only be recertified by a member of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Checked when the signature arrives, not on every later edit — the split 0057 introduced, for
-- the reason it introduced it: the person who recertified may leave, and a single
-- BEFORE INSERT OR UPDATE trigger would then refuse every future write to the agent over a
-- column the write never touched. Their attestation stands; it was true when they made it.
CREATE TRIGGER agents_recertifier_same_org_insert
  BEFORE INSERT ON agents
  FOR EACH ROW WHEN (NEW.recertified_by IS NOT NULL)
  EXECUTE FUNCTION sw_agent_recertifier_same_org();

CREATE TRIGGER agents_recertifier_same_org_update
  BEFORE UPDATE ON agents
  FOR EACH ROW WHEN (NEW.recertified_by IS NOT NULL AND NEW.recertified_by IS DISTINCT FROM OLD.recertified_by)
  EXECUTE FUNCTION sw_agent_recertifier_same_org();

-- How long an attestation is good for. It belongs beside the other numbers this organization
-- decides about how its assistant behaves — the nudge budget and the no-surprises window —
-- rather than in a constant, because "how often we review what our agents may do" is a policy
-- an auditor asks about and a company should be able to answer with its own number.
--
-- 90 days by default: the interval most access-review regimes settle on. The bounds stop it
-- being set to something that means "never" while still reading like a policy.
ALTER TABLE monitoring_policies
  ADD COLUMN agent_recertification_days integer NOT NULL DEFAULT 90;

ALTER TABLE monitoring_policies
  ADD CONSTRAINT monitoring_recertification_sane
    CHECK (agent_recertification_days BETWEEN 7 AND 365);

-- "Which agents is nobody standing behind", which is the read the governance screen makes.
CREATE INDEX agents_recertification_idx
  ON agents (organization_id, recertified_at)
  WHERE deleted_at IS NULL AND status = 'active';
