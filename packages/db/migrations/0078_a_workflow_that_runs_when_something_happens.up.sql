-- A workflow that runs when something happens (ADR 0090).
--
-- No new columns. `events` has existed since 0005 with a comment saying "Workflow triggers and
-- watchers read from here", and `workflow_runs.trigger_payload`, `is_replay` and `run_depth` have
-- existed since 0007. Nothing wrote or read any of them. This increment builds the feature the
-- schema was already shaped for.

-- The names this product emits, held where the rows are, so a subscription cannot be written for
-- an event nothing will ever raise. Same shape as `notifications_type_known`: a list in code and a
-- constraint beside the data, because the failure this prevents — a workflow subscribed to a name
-- with a typo in it, active and silent forever — looks exactly like a working automation.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_name_known;
ALTER TABLE events ADD CONSTRAINT events_name_known
  CHECK (name IN ('message.received', 'task.created', 'approval.decided'));

-- What fired a run, and how deep the causal chain was, are facts about a run that something else
-- caused. A manual or scheduled run has neither, and storing one against it would be a number
-- nobody can source.
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_payload_needs_a_cause;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_payload_needs_a_cause
  CHECK (trigger_payload = '{}'::jsonb OR trigger IN ('event', 'workflow'));

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_depth_needs_a_cause;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_depth_needs_a_cause
  CHECK (run_depth = 0 OR trigger IN ('event', 'workflow'));

-- A replay is a re-run against an event that has already been dispatched once. It is never how a
-- workflow first runs, so it cannot exist without something to replay.
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_replay_needs_an_event;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_replay_needs_an_event
  CHECK (is_replay = false OR trigger = 'event');

-- The dispatcher's question, asked once per event name per sweep: which published versions
-- subscribe to this name? Indexing the expression answers it without reading every graph.
CREATE INDEX workflow_versions_event_trigger_idx
  ON workflow_versions ((graph -> 'trigger' ->> 'spec'))
  WHERE (graph -> 'trigger' ->> 'kind') = 'event' AND deleted_at IS NULL;
