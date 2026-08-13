-- 0007 · rollback
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_last_simulation_fk;
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_current_version_fk;

DROP TABLE IF EXISTS schedules CASCADE;
DROP TABLE IF EXISTS workflow_step_runs CASCADE;
DROP TABLE IF EXISTS workflow_runs CASCADE;
DROP TABLE IF EXISTS workflow_versions CASCADE;
DROP TABLE IF EXISTS workflows CASCADE;

DROP TYPE IF EXISTS sw_workflow_run_status;
DROP TYPE IF EXISTS sw_workflow_status;
