DROP INDEX IF EXISTS tasks_milestone_idx;

DROP TRIGGER IF EXISTS tasks_milestone_belongs_to_project ON tasks;
DROP FUNCTION IF EXISTS sw_task_milestone_belongs_to_project();

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_milestone_needs_project;
