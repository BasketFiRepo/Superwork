-- 0006 · rollback
ALTER TABLE follow_ups DROP CONSTRAINT IF EXISTS follow_ups_agent_run_fk;
ALTER TABLE email_drafts DROP CONSTRAINT IF EXISTS email_drafts_agent_run_fk;
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_agent_run_fk;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_agent_run_fk;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_agent_run_fk;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_agent_run_fk;

DROP TABLE IF EXISTS trust_ledger_entries CASCADE;
DROP TABLE IF EXISTS insight_feedback CASCADE;
DROP TABLE IF EXISTS insights CASCADE;
DROP TABLE IF EXISTS memory_facts CASCADE;
DROP TABLE IF EXISTS undo_operations CASCADE;
DROP TABLE IF EXISTS citations CASCADE;
DROP TABLE IF EXISTS tool_calls CASCADE;
DROP TABLE IF EXISTS agent_messages CASCADE;
DROP TABLE IF EXISTS agent_steps CASCADE;
DROP TABLE IF EXISTS agent_runs CASCADE;
DROP TABLE IF EXISTS agent_permissions CASCADE;
DROP TABLE IF EXISTS agent_versions CASCADE;
DROP TABLE IF EXISTS agents CASCADE;

DROP TYPE IF EXISTS sw_insight_status;
DROP TYPE IF EXISTS sw_risk_tier;
DROP TYPE IF EXISTS sw_step_status;
DROP TYPE IF EXISTS sw_run_status;
DROP TYPE IF EXISTS sw_agent_status;
DROP TYPE IF EXISTS sw_agent_mode;
