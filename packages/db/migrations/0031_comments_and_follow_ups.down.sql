ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN ('nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready'));

DROP INDEX IF EXISTS notifications_one_per_follow_up;
DROP INDEX IF EXISTS follow_ups_owner_idx;
DROP INDEX IF EXISTS follow_ups_one_open_per_conversation;
ALTER TABLE follow_ups
  DROP CONSTRAINT IF EXISTS follow_ups_closed_has_time,
  DROP CONSTRAINT IF EXISTS follow_ups_resolution_known,
  DROP COLUMN IF EXISTS resolution_note,
  DROP COLUMN IF EXISTS resolution,
  DROP COLUMN IF EXISTS resolved_by,
  DROP COLUMN IF EXISTS resolved_at;
ALTER TABLE follow_ups DROP CONSTRAINT IF EXISTS follow_ups_status_known;

DROP TRIGGER IF EXISTS task_comments_mentions_in_org ON task_comments;
DROP FUNCTION IF EXISTS sw_task_comment_mentions_in_org();
ALTER TABLE task_comments
  DROP CONSTRAINT IF EXISTS task_comments_body_present,
  DROP CONSTRAINT IF EXISTS task_comments_agent_named;
