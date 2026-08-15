DROP INDEX IF EXISTS notification_preferences_one_per_person;
ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_hours_sane;
DROP INDEX IF EXISTS notifications_one_per_nudge;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
DROP INDEX IF EXISTS nudges_recipient_delivered_idx;
ALTER TABLE nudges DROP CONSTRAINT IF EXISTS nudges_answered_after_delivery;
ALTER TABLE nudges DROP COLUMN IF EXISTS response_note;
ALTER TABLE nudges DROP CONSTRAINT IF EXISTS nudges_response_known;
