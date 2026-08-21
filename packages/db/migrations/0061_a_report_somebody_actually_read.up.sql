-- 0061 — A report somebody actually read.
--
-- `agent_digests.read_at` has existed since the digest was built and nothing has ever written
-- it. `listDigests` selects it into every `DigestView`, and `DigestPanel` — the only thing that
-- renders a digest — never receives it. Another column the interface fetches and drops.
--
-- Reading the code for why turned up the bigger half. The digest's own header says an agent
-- that acts unattended "has to report, in one place, everything it did", and the AI-governance
-- screen says "Every agent has a named accountable human". `saveDigest` writes the row, writes
-- a disclosure to everyone named in it — and **tells the owner nothing**. The report is filed
-- to a table the accountable human reaches only by opening Settings, choosing Agents, choosing
-- that agent, and scrolling. An agent reporting into a void is not reporting.
--
-- So `read_at` could not be written because there was nothing to read it *from*. This migration
-- is the small half — the delivery is in `saveDigest` and the receipt is `markDigestRead`.

-- The weekly digest is a kind of notification now, so the allow-list has to know the word.
-- Re-stated in full rather than added to, because the constraint is the list.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure', 'agent_digest'
    ));

-- "What has this person not read yet", which is the read the gate makes on every unattended
-- run and the agent page makes on every load.
CREATE INDEX agent_digests_unread_idx
  ON agent_digests (organization_id, recipient_user_id, period_from DESC)
  WHERE deleted_at IS NULL AND read_at IS NULL;

/**
 * A receipt is the recipient's, or it is not a receipt.
 *
 * `read_at` says the accountable human read what their agent did. Somebody else marking it read
 * would be forging that, and the governance screen would then say an agent is overseen when
 * nobody has looked at it. The repository refuses it; this makes it true of every writer.
 *
 * Only the arrival of the mark is checked, not every later edit — the split 0057 introduced.
 * A digest is immutable once written, but the retention sweep sets `deleted_at` on old ones,
 * and a rule about `read_at` has no business refusing that.
 */
CREATE OR REPLACE FUNCTION sw_digest_read_by_recipient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.read_at IS NOT NULL AND NEW.recipient_user_id IS NULL THEN
    RAISE EXCEPTION 'a digest nobody was sent cannot have been read'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_digests_read_by_recipient_insert
  BEFORE INSERT ON agent_digests
  FOR EACH ROW WHEN (NEW.read_at IS NOT NULL)
  EXECUTE FUNCTION sw_digest_read_by_recipient();

CREATE TRIGGER agent_digests_read_by_recipient_update
  BEFORE UPDATE ON agent_digests
  FOR EACH ROW WHEN (NEW.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at)
  EXECUTE FUNCTION sw_digest_read_by_recipient();
