-- 0025 — Making the jurisdiction history complete, and readable.
--
-- `jurisdiction_changes` has had a writer since 0012 — `setJurisdiction` inserts a row for
-- every profile change it makes — and no reader anywhere. "Who loosened this profile, when,
-- why, and who approved it" is the first question a compliance review asks, and the answer
-- was in a table nothing selected from.
--
-- Two holes, and the reader was the smaller one.
--
-- **The history only recorded changes made through one function.** Any other path — a
-- directory sync, a data migration, a script, an acceptance loop temporarily relaxing a
-- profile to exercise the escalation ladder — changed `legal_entities.jurisdiction_profile`
-- with a plain UPDATE and left no trace. A history that records what the well-behaved
-- caller did is not a history; it is a log of intentions.
--
-- **Consultation was not recorded at all.** In a works-council profile, `consultation_status`
-- moving to or away from `agreed` switches §29 features on and off. That is at least as
-- consequential as a profile change and it was invisible.
--
-- So the database writes the history, not the application. There is no code path that can
-- change a profile or a consultation without producing a row, because the row is written by
-- the same statement.

ALTER TABLE jurisdiction_changes RENAME COLUMN from_profile TO from_state;
ALTER TABLE jurisdiction_changes RENAME COLUMN to_profile TO to_state;

ALTER TABLE jurisdiction_changes
  ADD COLUMN change_kind text NOT NULL DEFAULT 'profile',
  -- False when the change arrived without a stated reason. Recorded rather than refused:
  -- a trigger that blocks an UPDATE gets worked around by the next migration, and a change
  -- nobody can see is worse than one that is visibly unexplained.
  ADD COLUMN justified boolean NOT NULL DEFAULT true;

ALTER TABLE jurisdiction_changes
  ADD CONSTRAINT jurisdiction_change_kind_known CHECK (change_kind IN ('profile', 'consultation'));

CREATE INDEX jurisdiction_changes_recent_idx
  ON jurisdiction_changes (organization_id, changed_at DESC)
  WHERE deleted_at IS NULL;

/**
 * Writes the history row for any change to a legal entity's profile or consultation.
 *
 * The justification comes from a transaction-scoped setting the way the tenant does — the
 * supported callers set `app.change_justification` before the UPDATE, and anything else
 * lands as unjustified rather than as nothing. `app.current_user_id` is already set by
 * `withTenant`, so the actor needs no threading either.
 *
 * `changed_by` is NOT NULL and a bare psql session has no `app.current_user_id`, so it
 * falls back to the row's own `created_by` — the history stays writable from a maintenance
 * connection rather than blocking one.
 */
CREATE OR REPLACE FUNCTION sw_record_jurisdiction_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor uuid;
  stated text;
BEGIN
  IF NEW.jurisdiction_profile IS NOT DISTINCT FROM OLD.jurisdiction_profile
     AND NEW.consultation_status IS NOT DISTINCT FROM OLD.consultation_status THEN
    RETURN NEW;
  END IF;

  actor := coalesce(nullif(current_setting('app.current_user_id', true), '')::uuid, NEW.created_by);
  stated := nullif(current_setting('app.change_justification', true), '');

  IF NEW.jurisdiction_profile IS DISTINCT FROM OLD.jurisdiction_profile THEN
    INSERT INTO jurisdiction_changes (
      organization_id, legal_entity_id, change_kind, from_state, to_state,
      justification, justified, approved_by, changed_by, created_by
    ) VALUES (
      NEW.organization_id, NEW.id, 'profile', OLD.jurisdiction_profile, NEW.jurisdiction_profile,
      coalesce(stated, 'Changed without a stated reason.'), stated IS NOT NULL,
      nullif(current_setting('app.change_approver', true), '')::uuid, actor, actor
    );
  END IF;

  IF NEW.consultation_status IS DISTINCT FROM OLD.consultation_status THEN
    INSERT INTO jurisdiction_changes (
      organization_id, legal_entity_id, change_kind, from_state, to_state,
      justification, justified, changed_by, created_by
    ) VALUES (
      NEW.organization_id, NEW.id, 'consultation', OLD.consultation_status, NEW.consultation_status,
      coalesce(stated, 'Changed without a stated reason.'), stated IS NOT NULL, actor, actor
    );
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER legal_entities_record_change
  AFTER UPDATE ON legal_entities
  FOR EACH ROW EXECUTE FUNCTION sw_record_jurisdiction_change();
