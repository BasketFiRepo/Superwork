-- 0021 · rollback

DROP TRIGGER IF EXISTS task_dependencies_same_org ON task_dependencies;
DROP TRIGGER IF EXISTS task_dependencies_no_cycle ON task_dependencies;
DROP FUNCTION IF EXISTS sw_task_dependency_same_org();
DROP FUNCTION IF EXISTS sw_task_dependency_no_cycle();

ALTER TABLE task_dependencies DROP COLUMN IF EXISTS reason;

DROP INDEX IF EXISTS task_dependencies_blocking_idx;
