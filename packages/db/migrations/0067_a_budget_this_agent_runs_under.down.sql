-- Undoes 0067. `agents.budget` is 0006's and stays, holding whatever anybody tightened it to —
-- what goes is the enforcement of the ceiling, the record of who set it, and the same-org rule.
--
-- A budget left behind by this rollback is still honoured by the runtime, because the runtime
-- reads the column rather than the constraint. That is the safe direction: a tightening survives
-- losing the rule that bounded it.

DROP TRIGGER IF EXISTS agents_budget_setter_same_org_update ON agents;
DROP TRIGGER IF EXISTS agents_budget_setter_same_org_insert ON agents;
DROP FUNCTION IF EXISTS sw_agent_budget_setter_same_org();

DROP TRIGGER IF EXISTS agents_budget_within_default_update ON agents;
DROP TRIGGER IF EXISTS agents_budget_within_default_insert ON agents;
DROP FUNCTION IF EXISTS sw_agent_budget_within_default();

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_budget_attributed,
  DROP COLUMN IF EXISTS budget_reason,
  DROP COLUMN IF EXISTS budget_set_at,
  DROP COLUMN IF EXISTS budget_set_by;
