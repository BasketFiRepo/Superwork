-- 0058 — A decision somebody stood behind.
--
-- `decisions.confirmed_at` and `confirmed_by` have existed since migration 0010. Nothing has
-- ever written either. Two screens read them:
--
--   The **decision log** on /meetings has a "Confirmed" column that renders `yes` or
--   `not yet`. It has said `not yet` for every row since Phase 1 and always would have.
--   The **meeting page**'s decisions panel is subtitled "Recorded from the transcript —
--   confirm anything that reads wrong", which is an instruction pointing at a control that
--   does not exist.
--
-- What makes the gap worth closing rather than deleting: `recordDecision` is called from
-- exactly one place, the agent's meeting summarizer. Every decision in the log was extracted
-- by a model from a transcript and carries a `confidence` — 0.82, 0.9 — and an `agent_run_id`.
-- So the decision log is a list of the assistant's readings of what was said, presented as the
-- record of what was decided, with no way for anybody who was in the room to say yes.
--
-- The same shape `memory_facts` already has, and for the same stated reason: an assistant
-- confirming its own observation is how a wrong inference becomes the foundation of every
-- later answer. There, `confirmed_by` is NOT NULL by constraint and an agent actor is refused.
-- Here the confirmation is optional — an unconfirmed decision is still a record of an
-- extraction, and saying so is more honest than hiding it — but when it exists it is a
-- person's, and it is signed.

-- Both, or neither. A confirmation with no name on it is a claim that somebody agreed
-- without saying who, which is the thing this column exists to stop.
--
-- Validated rather than NOT VALID, unlike 0054, 0056 and 0057. Those added the attribution
-- columns in the same migration, so a down-and-up over live data would meet rows the CHECK
-- could not be made true of. These two columns are 0010's and the down script leaves them
-- where they are, so there is no such row: every existing decision has both NULL, which
-- satisfies this. A constraint that can be validated should be.
ALTER TABLE decisions
  ADD CONSTRAINT decisions_confirmation_attributed
    CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL));

/**
 * A decision is confirmed by somebody who is here.
 *
 * The guarantee `sw_conversation_assignee_same_org` and `sw_team_scope_same_org` make: a
 * foreign key to `users` says the person exists and nothing about which organization they are
 * in. A decision signed by somebody in another tenant would name a person this organization
 * cannot see, on the record that says who agreed to what.
 */
CREATE OR REPLACE FUNCTION sw_decision_confirmer_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = NEW.confirmed_by AND organization_id = NEW.organization_id
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a decision can only be confirmed by a member of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Checked when the signature arrives, not on every later edit — the split 0057 introduced and
-- the reason generalizes here: somebody who confirmed a decision may leave the organization
-- afterwards, and a single BEFORE INSERT OR UPDATE trigger would then refuse every future
-- write to that row over a column the write never touched. Their signature stands; it was
-- true when they made it, and the audit trail says when.
CREATE TRIGGER decisions_confirmer_same_org_insert
  BEFORE INSERT ON decisions
  FOR EACH ROW WHEN (NEW.confirmed_by IS NOT NULL)
  EXECUTE FUNCTION sw_decision_confirmer_same_org();

CREATE TRIGGER decisions_confirmer_same_org_update
  BEFORE UPDATE ON decisions
  FOR EACH ROW WHEN (NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by)
  EXECUTE FUNCTION sw_decision_confirmer_same_org();

-- "What has nobody stood behind yet", which is the read the decision log makes once the
-- column means something.
CREATE INDEX decisions_unconfirmed_idx
  ON decisions (organization_id, decided_at DESC)
  WHERE deleted_at IS NULL AND confirmed_at IS NULL;
