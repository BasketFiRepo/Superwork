ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
DELETE FROM notifications WHERE type = 'insight_returned';
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure', 'agent_digest',
      'approval_delegated'
    ));

DROP INDEX IF EXISTS insights_snoozed_until_idx;

DROP TRIGGER IF EXISTS insights_snoozer_same_org_update ON insights;
DROP TRIGGER IF EXISTS insights_snoozer_same_org_insert ON insights;
DROP FUNCTION IF EXISTS sw_insight_snoozer_same_org();

DROP TRIGGER IF EXISTS insights_snooze_ends_later_update ON insights;
DROP TRIGGER IF EXISTS insights_snooze_ends_later_insert ON insights;
DROP FUNCTION IF EXISTS sw_insight_snooze_ends_later();

ALTER TABLE insights
  DROP CONSTRAINT IF EXISTS insights_snooze_attributed,
  DROP CONSTRAINT IF EXISTS insights_snooze_has_an_end;

ALTER TABLE insights
  DROP COLUMN IF EXISTS snooze_reason,
  DROP COLUMN IF EXISTS snoozed_by;

-- Back to 0006's column, default included. Rows carry no value to restore: nothing ever set it,
-- which is why it went.
ALTER TABLE insights
  ADD COLUMN IF NOT EXISTS confidence numeric(4,3) NOT NULL DEFAULT 0.8;
