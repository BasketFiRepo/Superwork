DROP INDEX IF EXISTS subscriptions_renewal_due_idx;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_period_ends_after_start,
  DROP CONSTRAINT IF EXISTS subscriptions_plan_change_explained;

ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS provider_reference,
  DROP COLUMN IF EXISTS plan_change_reason,
  DROP COLUMN IF EXISTS plan_changed_at,
  DROP COLUMN IF EXISTS plan_changed_by;

-- `period_end` is left where the rollback finds it. The column existed before this migration and
-- the values it now holds are real periods somebody's plan is inside; clearing them would end
-- every renewal in the installation to undo a schema change.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure', 'agent_digest',
      'approval_delegated', 'insight_returned'
    ));
