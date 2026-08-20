-- 0054 — Correspondence that can be classified.
--
-- Nine tables carry a `sensitivity` column. Three of them mean something: `documents` and
-- `document_chunks` are set, cascaded and filtered on, and `companies`/`contacts` are set when
-- somebody adds one (ADR 0056) and filtered on the relationship view. The other five —
-- `conversations`, `messages`, `notes`, `tasks`, `projects` — have carried the column since
-- Phase 0 with the default `internal`, written by nothing and read by nothing.
--
-- The policy engine says so out loud, and is wrong about it:
--
--     -- ... every unclassified resource — tasks, projects and notes have no
--     -- classification column at all — above the guest ceiling of `public`.
--
-- They all have one. `checkClearance` never sees it because no repository puts it in the
-- `Resource` it checks, so the classification on a customer thread has never decided anything.
-- Every member holds `conversation:read:org`, the inbox lists every thread in the organization,
-- and there was no way to say that one of them should not be on that list.
--
-- This migration does the correspondence: a thread, and the messages in it. `notes`, `tasks` and
-- `projects` are deliberately left, and the reason is not tidiness — see ADR 0061. Enforcing a
-- classification those three already carry would put every task back above the guest ceiling,
-- which is the regression migration 0038's clearance change was written to undo.

ALTER TABLE conversations
  -- 'unset' is the state every existing thread is in, and the state the column has to be able to
  -- express: `internal` on a row nobody weighed is a default, not a decision, and a screen that
  -- cannot tell the two apart teaches people that everything has been reviewed (ADRs 0044, 0046).
  ADD COLUMN sensitivity_source text NOT NULL DEFAULT 'unset',
  ADD COLUMN sensitivity_set_by uuid REFERENCES users(id),
  ADD COLUMN sensitivity_set_at timestamptz,
  ADD COLUMN sensitivity_reason text;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_sensitivity_source_known
    CHECK (sensitivity_source IN ('unset', 'human')),
  -- The same shape as `documents_human_classification_is_attributed` (ADR 0041). A decision
  -- nobody signed is exactly what these columns exist to make impossible.
  ADD CONSTRAINT conversations_classification_attributed
    CHECK (
      sensitivity_source <> 'human'
      OR (sensitivity_set_by IS NOT NULL AND sensitivity_set_at IS NOT NULL
          AND length(btrim(coalesce(sensitivity_reason, ''))) >= 4)
    );

-- An unweighed thread carries the default and nothing else, so `unset` is unambiguous wherever
-- it is read.
--
-- NOT VALID, for the reason ADR 0054 recorded: the down migration drops the attribution columns
-- and leaves `sensitivity` where it is, so re-applying over a database where somebody had
-- classified a thread would meet a row this constraint cannot be made true of — the attribution
-- that justified it no longer exists. It holds for every write from here.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_unset_is_default
    CHECK (sensitivity_source <> 'unset' OR sensitivity = 'internal') NOT VALID;

-- Everything somebody decided about a thread, most recent first.
CREATE INDEX conversations_classified_idx
  ON conversations (organization_id, sensitivity_set_at DESC)
  WHERE sensitivity_source = 'human' AND deleted_at IS NULL;

-- The list reads this on every row now, and the inbox is the busiest screen here.
CREATE INDEX conversations_sensitivity_idx
  ON conversations (organization_id, sensitivity)
  WHERE deleted_at IS NULL;

/**
 * A message is as classified as the thread it is in, and the database is what keeps that true.
 *
 * The alternative is classifying each message, and it is worse: a thread marked confidential
 * with one message still marked internal is a leak that reads as a rounding error, and every
 * caller that writes a message would have to remember to look the thread up. When two places
 * must agree, the agreement is not something application code should be trusted to remember
 * (ADRs 0028, 0030, 0032, 0036, 0040, 0042, 0047).
 *
 * So `messages.sensitivity` is derived. Writing it directly does not fail — it is overwritten,
 * which is the behaviour that cannot be got wrong by a caller that does not know about this.
 */
CREATE OR REPLACE FUNCTION sw_message_inherits_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT c.sensitivity INTO NEW.sensitivity
  FROM conversations c
  WHERE c.id = NEW.conversation_id AND c.organization_id = NEW.organization_id;
  -- A message with no thread keeps whatever it was given; the foreign key decides whether that
  -- row is allowed to exist at all, and this trigger is not the place to duplicate that answer.
  IF NEW.sensitivity IS NULL THEN
    NEW.sensitivity := 'internal'::sw_sensitivity;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER messages_inherit_thread_classification
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION sw_message_inherits_thread();

/**
 * And a thread's decision reaches the messages already in it.
 *
 * Without this, classifying a thread confidential would leave every message already sent still
 * carrying `internal` — which is the level the agent's read path and every future filter
 * actually check. Somebody classifying a thread is deciding about the thread and everything in
 * it, exactly as ADR 0044 decided for a document and its passages.
 */
CREATE OR REPLACE FUNCTION sw_thread_classification_cascade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sensitivity IS DISTINCT FROM OLD.sensitivity THEN
    UPDATE messages
    SET sensitivity = NEW.sensitivity, updated_at = now()
    WHERE organization_id = NEW.organization_id AND conversation_id = NEW.id
      AND sensitivity IS DISTINCT FROM NEW.sensitivity;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER conversations_classification_cascade
  AFTER UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION sw_thread_classification_cascade();
