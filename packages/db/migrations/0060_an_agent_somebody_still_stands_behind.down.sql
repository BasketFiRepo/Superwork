-- Undoes 0060. `agents.recertified_at` belongs to 0006 and stays where it is; what goes is the
-- attestation around it — who read what, and how long it is good for.

DROP INDEX IF EXISTS agents_recertification_idx;

ALTER TABLE monitoring_policies DROP CONSTRAINT IF EXISTS monitoring_recertification_sane;
ALTER TABLE monitoring_policies DROP COLUMN IF EXISTS agent_recertification_days;

DROP TRIGGER IF EXISTS agents_recertifier_same_org_update ON agents;
DROP TRIGGER IF EXISTS agents_recertifier_same_org_insert ON agents;
DROP FUNCTION IF EXISTS sw_agent_recertifier_same_org();

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_recertification_attributed;
ALTER TABLE agents
  DROP COLUMN IF EXISTS recertification_note,
  DROP COLUMN IF EXISTS recertified_version,
  DROP COLUMN IF EXISTS recertified_by;
