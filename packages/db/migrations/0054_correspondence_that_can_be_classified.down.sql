-- 0054 down.
--
-- The classification itself stays on the rows: `conversations.sensitivity` and
-- `messages.sensitivity` existed before this migration and are not ours to reset. What goes is
-- the record of who decided and why — which is why re-applying carries `NOT VALID` on the
-- constraint that would otherwise have to be true of a row whose justification this dropped.

DROP TRIGGER IF EXISTS conversations_classification_cascade ON conversations;
DROP FUNCTION IF EXISTS sw_thread_classification_cascade();

DROP TRIGGER IF EXISTS messages_inherit_thread_classification ON messages;
DROP FUNCTION IF EXISTS sw_message_inherits_thread();

DROP INDEX IF EXISTS conversations_sensitivity_idx;
DROP INDEX IF EXISTS conversations_classified_idx;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_unset_is_default,
  DROP CONSTRAINT IF EXISTS conversations_classification_attributed,
  DROP CONSTRAINT IF EXISTS conversations_sensitivity_source_known;

ALTER TABLE conversations
  DROP COLUMN IF EXISTS sensitivity_reason,
  DROP COLUMN IF EXISTS sensitivity_set_at,
  DROP COLUMN IF EXISTS sensitivity_set_by,
  DROP COLUMN IF EXISTS sensitivity_source;
