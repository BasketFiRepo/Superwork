-- 0070 — Who was actually in the room.
--
-- `meeting_participants.attended` has existed since 0010. It is selected into `ParticipantView`
-- by `listParticipants`, and the only thing that has ever written it is the seed.
--
-- What makes that worse than an ordinary empty column is the sentence resting on it. The personal
-- record — the screen §29.3 exists for, the one that tells a person what Superwork knows about
-- them — carries a row labelled "Meetings you attended", described as "Attendance, and the lines
-- you spoke". Its count is `count(*) FROM meeting_participants WHERE user_id = …`, which is the
-- number of meetings somebody put your name on. The product has been showing people their
-- invitations and calling it their attendance.
--
-- The asymmetry is the tell. Consent on this same table is properly built: `consented_at` is
-- written by `recordConsent`, and `consentState` genuinely refuses a transcript without it.
-- Somebody built the harder half of this subsystem and left the easier half as a column.

-- ---------------------------------------------------------------------------------------------
-- A second place the same fact would live

-- `recording_consent_state` has never been read or written. The consent state the product
-- actually uses is derived, in `consentState`, from `meeting_participants.consented_at` — one
-- row per person, with the moment each of them agreed. A jsonb blob on the meeting is the same
-- fact kept a second way, and the two would disagree the first time anybody wrote to it. The
-- same reason `contacts.next_step` went in 0062 and `workflow_step_runs.cost_cents` in 0064.
ALTER TABLE meetings DROP COLUMN recording_consent_state;

-- ---------------------------------------------------------------------------------------------
-- Who says so

-- Attendance is a statement about a person, and one of the three values is a statement they may
-- disagree with. "Ellie was not there" needs a name against it for the same reason a
-- classification does (ADR 0041): a fact about somebody that nobody is answerable for is a
-- rumour the database is repeating.
ALTER TABLE meeting_participants
  ADD COLUMN attended_set_by uuid REFERENCES users(id),
  ADD COLUMN attended_set_at timestamptz;

-- Deliberately no `attended_reason`. The attribution pattern elsewhere carries one, and here it
-- would be a field inviting somebody to record *why* a colleague was absent — which is a note
-- about a person rather than a fact about a meeting, and the beginning of the file §29.5 exists
-- to prevent. Who says they were not there is answerable; why they were not there is theirs.

-- ---------------------------------------------------------------------------------------------
-- What the existing rows were saying

-- First: unsay the attendance of meetings that have not happened. Every future meeting carries
-- `attended = false` for everybody on it, which reads as "these people did not come" about a
-- room that has not opened. That is not a missing value, it is the wrong one — *did not attend*
-- and *not recorded* are different facts and only one of them is about a person's conduct.
UPDATE meeting_participants mp
   SET attended = NULL
  FROM meetings m
 WHERE m.id = mp.meeting_id
   AND mp.attended IS NOT NULL
   AND m.starts_at > now();

-- Then attribute what is left to whoever wrote the row, because that is who asserted it. A row
-- whose creator is gone, or was never a member here, keeps no attendance at all: the constraint
-- below is about there being somebody answerable, and inventing a name to satisfy it would make
-- the column lie in a new way rather than an old one.
UPDATE meeting_participants mp
   SET attended_set_by = mp.created_by,
       attended_set_at = mp.created_at
 WHERE mp.attended IS NOT NULL
   AND mp.created_by IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM memberships mm
      WHERE mm.user_id = mp.created_by
        AND mm.organization_id = mp.organization_id
        AND mm.deleted_at IS NULL
   );

UPDATE meeting_participants
   SET attended = NULL
 WHERE attended IS NOT NULL AND attended_set_by IS NULL;

ALTER TABLE meeting_participants
  ADD CONSTRAINT meeting_participants_attendance_attributed CHECK (
    attended IS NULL OR (attended_set_by IS NOT NULL AND attended_set_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------------------------
-- Two rules the database keeps

-- Nobody knows who turned up to a meeting that has not happened. The seed wrote `attended =
-- false` for every future meeting, which reads as "these people did not come" about a room that
-- has not opened — the difference between *did not attend* and *not recorded* collapsed into the
-- value that accuses somebody.
--
-- A trigger rather than a CHECK, for the reason `logInteraction` already states about the same
-- shape: a constraint cannot call `now()`, and a row that was legitimate when written must not
-- turn invalid as the clock passes it.
CREATE OR REPLACE FUNCTION sw_attendance_not_before_the_meeting() RETURNS trigger AS $$
DECLARE
  began timestamptz;
BEGIN
  SELECT m.starts_at INTO began FROM meetings m WHERE m.id = NEW.meeting_id;
  IF began IS NOT NULL AND began > now() THEN
    RAISE EXCEPTION 'attendance cannot be recorded for a meeting that has not started; leave it unrecorded until it has';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Split across insert and update (ADR 0057), because this rule *refuses*: editing a participant's
-- display name years later must not be turned down over an attendance the edit never touched.
CREATE TRIGGER meeting_participants_attendance_timing_insert
  BEFORE INSERT ON meeting_participants
  FOR EACH ROW WHEN (NEW.attended IS NOT NULL)
  EXECUTE FUNCTION sw_attendance_not_before_the_meeting();

CREATE TRIGGER meeting_participants_attendance_timing_update
  BEFORE UPDATE ON meeting_participants
  FOR EACH ROW WHEN (NEW.attended IS DISTINCT FROM OLD.attended)
  EXECUTE FUNCTION sw_attendance_not_before_the_meeting();

-- And the person named as having said so has to be somebody in this organization. The same rule
-- `sw_agent_budget_setter_same_org` keeps, for the same reason: a foreign key to `users` reaches
-- every tenant, so on its own it says almost nothing.
CREATE OR REPLACE FUNCTION sw_attendance_setter_same_org() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships mm
    WHERE mm.user_id = NEW.attended_set_by
      AND mm.organization_id = NEW.organization_id
      AND mm.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'attendance can only be recorded by a member of this organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_participants_attendance_setter_insert
  BEFORE INSERT ON meeting_participants
  FOR EACH ROW WHEN (NEW.attended_set_by IS NOT NULL)
  EXECUTE FUNCTION sw_attendance_setter_same_org();

-- `IS NOT NULL` first, and it is load-bearing rather than tidy. Without it, clearing the
-- attribution — which is what withdrawing an attendance record does — fires this trigger with
-- `NEW.attended_set_by` null, finds no membership for nobody, and refuses. A record that could
-- be made and never unmade is worse than one that could not be made at all, and the test that
-- withdraws one is what found it.
CREATE TRIGGER meeting_participants_attendance_setter_update
  BEFORE UPDATE ON meeting_participants
  FOR EACH ROW WHEN (
    NEW.attended_set_by IS NOT NULL AND NEW.attended_set_by IS DISTINCT FROM OLD.attended_set_by
  )
  EXECUTE FUNCTION sw_attendance_setter_same_org();

-- ---------------------------------------------------------------------------------------------
-- The read the personal record makes

-- "Which meetings did I actually attend" — keyed on the person, which no index on this table
-- serves: 0010's is (organization_id, meeting_id) and 0062's is on the contact. Partial, because
-- the count that matters is of the rows where somebody recorded an answer.
CREATE INDEX meeting_participants_attended_idx
  ON meeting_participants (organization_id, user_id)
  WHERE attended AND deleted_at IS NULL;
