-- Undoes 0058. `confirmed_at` and `confirmed_by` belong to 0010 and stay, signatures and all;
-- what goes is the guarantee that they arrive together and name somebody who is here.

DROP INDEX IF EXISTS decisions_unconfirmed_idx;

DROP TRIGGER IF EXISTS decisions_confirmer_same_org_update ON decisions;
DROP TRIGGER IF EXISTS decisions_confirmer_same_org_insert ON decisions;
DROP FUNCTION IF EXISTS sw_decision_confirmer_same_org();

ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_confirmation_attributed;
