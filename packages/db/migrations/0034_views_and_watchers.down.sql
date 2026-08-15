ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention'
    ));

DROP INDEX IF EXISTS task_watchers_user_idx;
DROP TRIGGER IF EXISTS task_watchers_same_org ON task_watchers;
DROP FUNCTION IF EXISTS sw_task_watcher_same_org();

DROP INDEX IF EXISTS saved_views_reader_idx;
DROP INDEX IF EXISTS saved_views_one_name_per_person;
ALTER TABLE saved_views
  DROP CONSTRAINT IF EXISTS saved_views_has_owner,
  DROP CONSTRAINT IF EXISTS saved_views_query_is_object,
  DROP CONSTRAINT IF EXISTS saved_views_name_present,
  DROP CONSTRAINT IF EXISTS saved_views_entity_known;
