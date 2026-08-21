-- 0056 down.
--
-- `assigned_to` predates this migration and stays; what goes is the record of who made the
-- assignment, which is why re-applying carries NOT VALID on the constraint that would otherwise
-- have to be true of a row whose attribution this dropped.

DROP TRIGGER IF EXISTS conversations_assignee_same_org ON conversations;
DROP FUNCTION IF EXISTS sw_conversation_assignee_same_org();

DROP INDEX IF EXISTS conversations_assigned_idx;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_assignment_attributed;

ALTER TABLE conversations
  DROP COLUMN IF EXISTS assigned_by,
  DROP COLUMN IF EXISTS assigned_at;
