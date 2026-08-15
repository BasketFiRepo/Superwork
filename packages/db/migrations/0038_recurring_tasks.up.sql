-- 0038 — Work that comes back.
--
-- `tasks.recurrence_rule` has existed since migration 0002 and nothing has ever written to it
-- or read it. Every recurring obligation an operations team has — the weekly temperature
-- logs, the monthly reconciliation, the quarterly audit booking — was retyped by a person
-- each time, or forgotten. The seed's own task list is full of them.
--
-- A recurrence needs three things the column alone cannot give:
--
--   **A series.** Occurrence three has to know it is the same recurring thing as occurrence
--   two, or "stop repeating this" has nothing to stop.
--
--   **Exactly one open occurrence.** A rule that materialises fifty-two rows floods every
--   list it appears in and makes the overdue count meaningless. One at a time is the only
--   shape a person can work with, and it is an invariant rather than a habit — so the
--   database holds it rather than the code that creates the next one.
--
--   **A date to count from.** "Every Monday" after nothing is not a date.

ALTER TABLE tasks
  ADD COLUMN recurrence_series_id uuid;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_recurrence_needs_series
    CHECK (recurrence_rule IS NULL OR (recurrence_series_id IS NOT NULL AND due_at IS NOT NULL)),
  ADD CONSTRAINT tasks_recurrence_rule_shape
    CHECK (recurrence_rule IS NULL OR (length(btrim(recurrence_rule)) BETWEEN 1 AND 120));

-- One open occurrence per series. Completing an occurrence creates the next one, and this is
-- what stops a double completion — or two people completing at once — producing two.
CREATE UNIQUE INDEX tasks_one_open_occurrence
  ON tasks (organization_id, recurrence_series_id)
  WHERE recurrence_series_id IS NOT NULL
    AND deleted_at IS NULL
    AND status NOT IN ('completed', 'cancelled');

-- "What does this series look like over time", which is the read the history panel wants.
CREATE INDEX tasks_series_idx
  ON tasks (organization_id, recurrence_series_id, due_at DESC)
  WHERE recurrence_series_id IS NOT NULL AND deleted_at IS NULL;
