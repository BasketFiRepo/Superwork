-- Undoes 0068. `decisions.decided_at` is 0010's and stays, holding whatever was computed for it —
-- a date derived from the transcript is still the right date after the rule that checked it is
-- gone. What goes is the checking.

DROP TRIGGER IF EXISTS decisions_segment_same_meeting_update ON decisions;
DROP TRIGGER IF EXISTS decisions_segment_same_meeting_insert ON decisions;
DROP FUNCTION IF EXISTS sw_decision_segment_same_meeting();

DROP TRIGGER IF EXISTS decisions_decided_when_it_could_be_update ON decisions;
DROP TRIGGER IF EXISTS decisions_decided_when_it_could_be_insert ON decisions;
DROP FUNCTION IF EXISTS sw_decision_decided_when_it_could_be();
