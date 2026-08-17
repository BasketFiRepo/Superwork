DROP INDEX IF EXISTS notifications_pending_idx;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_delivery_known;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed'
    ));

ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_quiet_hours_valid,
  DROP CONSTRAINT IF EXISTS notification_preferences_per_type_known,
  DROP CONSTRAINT IF EXISTS notification_preferences_channels_known;

DROP FUNCTION IF EXISTS sw_quiet_hours_ok(jsonb);
DROP FUNCTION IF EXISTS sw_delivery_map_ok(jsonb);
