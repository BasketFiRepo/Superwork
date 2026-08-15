-- 0024 — Making a reporting line mean something.
--
-- `reporting_relationships` was created in migration 0001 and seeded with a real org chart —
-- eleven lines including one dotted — and read by nothing. Three controls sit on top of it
-- and all three were hollow:
--
--   • the nudge ladder's fifth rung declares `audience: 'manager'`, and every rung is
--     delivered to `recipient_user_id` regardless. The escalation was sent to the *owner*,
--     carrying a message written in the third person about them;
--   • `noSurprisesReviewHours` is defined on every jurisdiction profile, surfaced on the
--     transparency screen, quoted in the compliance review's evidence — and enforced
--     nowhere;
--   • the compliance review counts stage-5 nudges as "escalation(s) recorded", which was
--     evidence about something that had never happened.
--
-- What the schema was missing to support any of that.

-- Reads go both ways. The only index was on (organization_id, person_id) — "who manages
-- me" — and resolving a manager's reports is the other direction.
CREATE INDEX reporting_manager_idx
  ON reporting_relationships (organization_id, manager_id)
  WHERE deleted_at IS NULL;

-- `type` was a free-text column defaulting to 'functional'. The distinction is load-bearing:
-- a functional line is the one that routes an escalation, a dotted line is context.
ALTER TABLE reporting_relationships
  ADD CONSTRAINT reporting_type_known CHECK (type IN ('functional', 'dotted'));

-- One functional manager at a time. A person with two of them has no answer to "who does
-- this escalate to", and picking one arbitrarily is how an escalation reaches the wrong
-- person quietly. Dotted lines are deliberately unconstrained — having several is the point.
CREATE UNIQUE INDEX reporting_one_functional_manager
  ON reporting_relationships (organization_id, person_id)
  WHERE deleted_at IS NULL AND valid_to IS NULL AND type = 'functional';

/**
 * Refuses a line that would close a loop in the functional chain.
 *
 * The edge says `person_id` reports to `manager_id`. A cycle exists if the manager already
 * reports — directly or transitively — to the person. An org chart with a loop is one where
 * an escalation walks forever, and the thing that eventually writes one is a directory sync,
 * not somebody clicking a button.
 *
 * Only functional lines are walked. A dotted line is not an escalation path, and matrix
 * organizations legitimately have dotted lines that would look like loops.
 */
CREATE OR REPLACE FUNCTION sw_reporting_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closes_loop boolean;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.type <> 'functional' OR NEW.valid_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE above(person_id, depth) AS (
    SELECT NEW.manager_id, 0
    UNION ALL
    SELECT r.manager_id, a.depth + 1
    FROM reporting_relationships r
    JOIN above a ON r.person_id = a.person_id
    WHERE r.deleted_at IS NULL AND r.valid_to IS NULL AND r.type = 'functional' AND a.depth < 100
  )
  SELECT EXISTS (SELECT 1 FROM above WHERE person_id = NEW.person_id) INTO closes_loop;

  IF closes_loop THEN
    RAISE EXCEPTION 'that reporting line would create a loop, and an escalation would never reach anybody'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER reporting_no_cycle
  BEFORE INSERT OR UPDATE ON reporting_relationships
  FOR EACH ROW EXECUTE FUNCTION sw_reporting_no_cycle();

-- Both people must be members of the organization the row claims. RLS stops one tenant
-- reading another's rows; nothing stopped a row *referencing* across the boundary, because
-- the FKs are to `users(id)` and a user can belong to several organizations.
CREATE OR REPLACE FUNCTION sw_reporting_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ends integer;
BEGIN
  SELECT count(DISTINCT user_id) INTO ends FROM memberships
  WHERE user_id IN (NEW.person_id, NEW.manager_id)
    AND organization_id = NEW.organization_id AND deleted_at IS NULL;

  IF ends <> 2 THEN
    RAISE EXCEPTION 'both people in a reporting line must be members of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER reporting_same_org
  BEFORE INSERT OR UPDATE ON reporting_relationships
  FOR EACH ROW EXECUTE FUNCTION sw_reporting_same_org();

-- Why the line is what it is, and who said so. An org chart with no provenance is one
-- nobody will correct, because nobody knows whether a line is deliberate or a sync artefact.
ALTER TABLE reporting_relationships ADD COLUMN reason text;
ALTER TABLE reporting_relationships ADD COLUMN set_by uuid REFERENCES users(id);

-- A nudge records who it went to and never who it was *about*. That was survivable while
-- every rung went to the owner; it is not survivable now that one goes to somebody else.
-- Without it there is no way, at delivery, to tell the subject that something about them
-- reached their manager — which is the promise the §29 profiles make.
ALTER TABLE nudges ADD COLUMN about_user_id uuid REFERENCES users(id);
CREATE INDEX nudges_about_idx ON nudges (organization_id, about_user_id)
  WHERE deleted_at IS NULL AND about_user_id IS NOT NULL;
