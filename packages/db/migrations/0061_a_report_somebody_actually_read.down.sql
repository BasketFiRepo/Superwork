-- Undoes 0061. `agent_digests.read_at` belongs to the digest's own migration and stays, receipts
-- and all; what goes is the delivery's place in the notification allow-list and the rule that a
-- digest nobody was sent cannot have been read.

DROP INDEX IF EXISTS agent_digests_unread_idx;

DROP TRIGGER IF EXISTS agent_digests_read_by_recipient_update ON agent_digests;
DROP TRIGGER IF EXISTS agent_digests_read_by_recipient_insert ON agent_digests;
DROP FUNCTION IF EXISTS sw_digest_read_by_recipient();

-- Any digest notification already written would fail the narrower list, so they go with it.
DELETE FROM notifications WHERE type = 'agent_digest';
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure'
    ));
