-- Undoes 0063. The columns and their defaults are untouched — what goes is the rule that the
-- default is the only value, which puts all three back to being a suggestion.

ALTER TABLE custom_tools DROP CONSTRAINT IF EXISTS custom_tools_never_reversible;
ALTER TABLE agent_simulations DROP CONSTRAINT IF EXISTS agent_simulations_always_simulated;
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_consent_always_required;
