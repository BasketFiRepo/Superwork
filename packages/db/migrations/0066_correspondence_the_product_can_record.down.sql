-- Undoes 0066.
--
-- `last_message_at` and `last_direction` keep whatever the trigger last computed, which is the
-- right answer at the moment it stops being maintained. What goes is the maintenance, the
-- vocabulary and the index.

DROP INDEX IF EXISTS messages_thread_latest_idx;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_trust_level_known;

DROP TRIGGER IF EXISTS messages_move_the_thread ON messages;
DROP FUNCTION IF EXISTS sw_conversation_last_message();
