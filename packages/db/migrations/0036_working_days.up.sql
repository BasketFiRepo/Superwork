-- 0036 — The days people do not work.
--
-- `departments.holiday_calendar` has existed since migration 0001 and nothing has ever
-- written to it or read it. The consequence was not cosmetic: the nudge ladder had no notion
-- of a day somebody does not work, so it chased people on Saturdays, on Sundays, and on
-- Christmas Day. §29 spends its length on how hard the system may chase somebody and said
-- nothing about *when*, because the column that could answer it was inert.
--
-- The column holds a calendar name. The dates behind each name are computed in the
-- application from the published rules — the same reasoning as every other external
-- dependency having a working mock, so the product still runs with no credentials.

ALTER TABLE departments
  ADD CONSTRAINT departments_holiday_calendar_known
    CHECK (holiday_calendar IS NULL OR holiday_calendar IN (
      'none', 'weekends', 'uk-england-wales', 'us-federal'
    ));

-- Why a reminder was held back, alongside the budget's reason. A nudge that silently did not
-- arrive is indistinguishable from a bug, which is the rule this table already follows for
-- cancellation (`cancel_reason`).
ALTER TABLE nudges
  ADD COLUMN held_reason text;

-- The lookup the delivery gate does for every reminder: which calendar governs this person.
-- Without it, chasing anybody costs a sequential scan of the membership table.
CREATE INDEX memberships_department_idx
  ON memberships (organization_id, user_id, department_id)
  WHERE deleted_at IS NULL;
