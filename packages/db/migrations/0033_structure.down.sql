DROP INDEX IF EXISTS knowledge_spaces_one_slug;
DROP INDEX IF EXISTS knowledge_spaces_one_name;
ALTER TABLE knowledge_spaces
  DROP CONSTRAINT IF EXISTS knowledge_spaces_sensitivity_known,
  DROP CONSTRAINT IF EXISTS knowledge_spaces_name_present;

DROP INDEX IF EXISTS milestones_project_due_idx;
DROP INDEX IF EXISTS milestones_one_name_per_project;
ALTER TABLE milestones
  DROP CONSTRAINT IF EXISTS milestones_done_has_time,
  DROP COLUMN IF EXISTS completed_by,
  DROP COLUMN IF EXISTS completed_at,
  DROP CONSTRAINT IF EXISTS milestones_name_present,
  DROP CONSTRAINT IF EXISTS milestones_status_known;

DROP TRIGGER IF EXISTS departments_path_cascade ON departments;
DROP FUNCTION IF EXISTS sw_department_path_cascade();
DROP TRIGGER IF EXISTS departments_path ON departments;
DROP FUNCTION IF EXISTS sw_department_path();
DROP TRIGGER IF EXISTS departments_parent_sane ON departments;
DROP FUNCTION IF EXISTS sw_department_parent_sane();
DROP INDEX IF EXISTS departments_parent_idx;
DROP INDEX IF EXISTS departments_one_name_per_parent;
