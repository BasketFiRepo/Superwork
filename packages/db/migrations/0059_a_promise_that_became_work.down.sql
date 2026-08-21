-- Undoes 0059. `commitments.task_id` belongs to 0010 and stays, links and all; what goes is
-- the rule that only our own promises carry one, that the task is in this organization, and
-- that finishing it is what keeps the promise.

DROP INDEX IF EXISTS commitments_task_idx;

DROP TRIGGER IF EXISTS tasks_completion_keeps_commitment ON tasks;
DROP FUNCTION IF EXISTS sw_commitment_kept_by_task();

DROP TRIGGER IF EXISTS commitments_task_same_org_update ON commitments;
DROP TRIGGER IF EXISTS commitments_task_same_org_insert ON commitments;
DROP FUNCTION IF EXISTS sw_commitment_task_same_org();

ALTER TABLE commitments DROP CONSTRAINT IF EXISTS commitments_task_is_ours;
