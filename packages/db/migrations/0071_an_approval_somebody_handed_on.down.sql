-- Back to exactly what 0061 left, plus nothing. Rows of the new type go first: the constraint
-- cannot be narrowed around them.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
DELETE FROM notifications WHERE type = 'approval_delegated';
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure', 'agent_digest'
    ));

DROP INDEX IF EXISTS approvals_delegated_idx;

DROP TRIGGER IF EXISTS approvals_delegation_same_org_update ON approvals;
DROP TRIGGER IF EXISTS approvals_delegation_same_org_insert ON approvals;
DROP FUNCTION IF EXISTS sw_approval_delegation_same_org();

ALTER TABLE approvals
  DROP CONSTRAINT IF EXISTS approvals_delegation_not_to_the_requester,
  DROP CONSTRAINT IF EXISTS approvals_delegation_moves,
  DROP CONSTRAINT IF EXISTS approvals_delegation_attributed;

ALTER TABLE approvals
  DROP COLUMN IF EXISTS delegation_reason,
  DROP COLUMN IF EXISTS delegated_at,
  DROP COLUMN IF EXISTS delegated_by;

-- The enum goes back to the seven values 0005 created, `'delegated'` included. A rollback that
-- left it out would leave the database describing a narrower world than the migration before it.
ALTER TABLE approvals ALTER COLUMN status DROP DEFAULT;
ALTER TYPE sw_approval_status RENAME TO sw_approval_status_new;
CREATE TYPE sw_approval_status AS ENUM (
  'pending', 'approved', 'approved_with_edits', 'rejected', 'delegated', 'expired', 'cancelled'
);
ALTER TABLE approvals
  ALTER COLUMN status TYPE sw_approval_status USING status::text::sw_approval_status;
ALTER TABLE approvals ALTER COLUMN status SET DEFAULT 'pending';
DROP TYPE sw_approval_status_new;
