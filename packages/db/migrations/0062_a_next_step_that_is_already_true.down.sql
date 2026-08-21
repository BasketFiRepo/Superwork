-- Undoes 0062.
--
-- The two columns come back exactly as they were — present, and holding nothing — because
-- nothing ever wrote them. What the up script removed was a *place* to write a fact the product
-- already knows; putting the place back does not put a fact in it, and no data is restored
-- because none was ever lost.

DROP INDEX IF EXISTS meeting_participants_contact_idx;
DROP INDEX IF EXISTS commitments_counterparty_due_idx;

ALTER TABLE contacts
  ADD COLUMN next_step_at timestamptz,
  ADD COLUMN next_step   text;
