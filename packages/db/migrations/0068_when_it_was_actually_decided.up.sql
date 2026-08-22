-- 0068 — When it was actually decided.
--
-- `decisions.decided_at` is `NOT NULL DEFAULT now()` and nothing in the product has ever set it.
-- It is not decorative: it is the `ORDER BY` of the decision log, and it is both of the table's
-- indexes. So the order the log is read in is the order the summarizer happened to run, and the
-- column that says when something was decided says when a row was written.
--
-- `recordDecision` is called from exactly one place — the meeting summarizer — and every decision
-- it writes carries a `source_segment_id`: the line in the transcript the decision was read out
-- of. Segments carry `starts_at_seconds`, and the meeting carries `starts_at`. **The moment a
-- decision was made is already in the data**, and has been since migration 0010. Nobody had
-- written the addition.
--
-- A decision summarised a week after the meeting therefore sorted above one made yesterday, and
-- the log — the artifact §12.5 calls the most valuable and most neglected in project work — was
-- ordered by nothing anybody would recognise.
--
-- The derivation is in `recordDecision`, where the segment is already in hand. What is here is
-- the pair of rules that has to hold whoever writes the row.

/**
 * A decision cannot have been made in the future, or before the meeting it came out of.
 *
 * A trigger rather than a CHECK, for the reason `logInteraction` states about the same rule: a
 * constraint cannot call `now()`, and a row that was legitimate when written must not become
 * invalid as the clock passes it. A trigger fires on the write and never again.
 *
 * The second half is the one the derivation could get wrong. A decision anchored to a segment of
 * the wrong meeting, or an offset from the wrong transcript, lands before its own meeting started
 * — which is a sum that has gone wrong rather than a date somebody typed, and exactly the failure
 * a trigger should catch rather than a reviewer.
 */
CREATE OR REPLACE FUNCTION sw_decision_decided_when_it_could_be() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  began timestamptz;
BEGIN
  -- A minute of slack, the same tolerance `logInteraction` and `recordMessage` allow: clocks on
  -- two machines are never exactly the same one, and a decision recorded as it is made must not
  -- be refused for being a few seconds ahead.
  IF NEW.decided_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'a decision cannot have been made in the future'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.meeting_id IS NOT NULL THEN
    SELECT m.starts_at INTO began FROM meetings m WHERE m.id = NEW.meeting_id;
    -- Also a minute, and for a different reason: a decision can be recorded against a meeting
    -- that is beginning, and the two timestamps are written by different statements.
    IF began IS NOT NULL AND NEW.decided_at < began - interval '1 minute' THEN
      RAISE EXCEPTION 'a decision cannot have been made before the meeting it came out of'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- The two-trigger split 0057 introduced: a guard narrowed to the arriving value, so confirming a
-- decision months later is not refused over a date the confirmation never touched.
CREATE TRIGGER decisions_decided_when_it_could_be_insert
  BEFORE INSERT ON decisions
  FOR EACH ROW EXECUTE FUNCTION sw_decision_decided_when_it_could_be();

CREATE TRIGGER decisions_decided_when_it_could_be_update
  BEFORE UPDATE ON decisions
  FOR EACH ROW WHEN (NEW.decided_at IS DISTINCT FROM OLD.decided_at)
  EXECUTE FUNCTION sw_decision_decided_when_it_could_be();

/**
 * And the segment a decision is read out of belongs to the meeting it is filed against.
 *
 * The anchor is what the date is computed from, so an anchor pointing into a different meeting's
 * transcript is a wrong date waiting to be written — and, separately, a citation that would send
 * a reader to the wrong room. The seed had exactly this shape of mistake: it anchored every
 * decision to the *first* segment of its meeting rather than the line the decision came from.
 */
CREATE OR REPLACE FUNCTION sw_decision_segment_same_meeting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.meeting_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM transcript_segments seg
    JOIN transcripts tr ON tr.id = seg.transcript_id
    WHERE seg.id = NEW.source_segment_id AND tr.meeting_id = NEW.meeting_id
  ) THEN
    RAISE EXCEPTION 'a decision can only cite a line from the meeting it came out of'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER decisions_segment_same_meeting_insert
  BEFORE INSERT ON decisions
  FOR EACH ROW WHEN (NEW.source_segment_id IS NOT NULL)
  EXECUTE FUNCTION sw_decision_segment_same_meeting();

CREATE TRIGGER decisions_segment_same_meeting_update
  BEFORE UPDATE ON decisions
  FOR EACH ROW WHEN (NEW.source_segment_id IS NOT NULL
    AND NEW.source_segment_id IS DISTINCT FROM OLD.source_segment_id)
  EXECUTE FUNCTION sw_decision_segment_same_meeting();
