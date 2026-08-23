DROP INDEX IF EXISTS meeting_participants_attended_idx;

DROP TRIGGER IF EXISTS meeting_participants_attendance_setter_update ON meeting_participants;
DROP TRIGGER IF EXISTS meeting_participants_attendance_setter_insert ON meeting_participants;
DROP FUNCTION IF EXISTS sw_attendance_setter_same_org();

DROP TRIGGER IF EXISTS meeting_participants_attendance_timing_update ON meeting_participants;
DROP TRIGGER IF EXISTS meeting_participants_attendance_timing_insert ON meeting_participants;
DROP FUNCTION IF EXISTS sw_attendance_not_before_the_meeting();

ALTER TABLE meeting_participants
  DROP CONSTRAINT IF EXISTS meeting_participants_attendance_attributed;
ALTER TABLE meeting_participants
  DROP COLUMN IF EXISTS attended_set_at,
  DROP COLUMN IF EXISTS attended_set_by;

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS recording_consent_state jsonb NOT NULL DEFAULT '{}'::jsonb;
