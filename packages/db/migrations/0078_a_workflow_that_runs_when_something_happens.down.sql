DROP INDEX IF EXISTS workflow_versions_event_trigger_idx;
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_replay_needs_an_event;
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_depth_needs_a_cause;
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_payload_needs_a_cause;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_name_known;
