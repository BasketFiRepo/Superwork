-- 0066 — Correspondence the product can record.
--
-- The only `INSERT INTO conversations` or `INSERT INTO messages` in this repository is in the
-- seed. Fourteen columns across the two tables are read by the product and written by nothing in
-- it, which is the largest single entry the coverage detector has ever had — and it is one fact:
-- **the correspondence record is a fixture.** Every thread in the demo was put there by
-- `seedThreads`, and a real customer signing in tomorrow would have an inbox that could never
-- contain anything.
--
-- Reading the code for why turned up the sharper half. Superwork already sends email: a draft is
-- approved, `email_sends` holds it for its recall window, and the worker dispatches it. On
-- success the worker sets `sent_at`, writes an activity — and never appends a message to the
-- thread. So the customer's message stays the last one in it. `last_direction` stays `inbound`,
-- `last_message_at` stays at their message, and `pastSla` in `SELECT_CONVERSATION` goes on
-- counting a reply we have already sent as one we owe.
--
-- The inbox chases threads it has itself answered. That is not a missing feature; it is the
-- product telling a person something untrue about work they did.

/**
 * A thread's last message is the last of its messages.
 *
 * `last_message_at` and `last_direction` are read by the queue's ordering, by the SLA test, by
 * the CRM's account timers and by the briefing. They were written once, by the seed, from a
 * number the seed also made up — and the moment anything else appends to a thread there are two
 * places holding one fact.
 *
 * So the database holds it, the way it holds an agent run's totals (0037) and a workflow run's
 * cost (0064), and for the same reason: when two places must agree, the agreement is not
 * something application code should be trusted to remember. Recomputed rather than moved
 * forward, so deleting a message that was filed by mistake leaves the thread's clock right
 * rather than leaving it at a message that is no longer there.
 *
 * `internal` messages count. A note somebody adds to a thread is still activity on it, and a
 * thread that went quiet because we only talked to ourselves is one the queue should still show.
 */
CREATE OR REPLACE FUNCTION sw_conversation_last_message() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid := coalesce(NEW.conversation_id, OLD.conversation_id);
BEGIN
  UPDATE conversations c
  SET last_message_at = latest.sent_at,
      last_direction = latest.direction
  FROM (
    SELECT m.sent_at, m.direction
    FROM messages m
    WHERE m.conversation_id = target AND m.deleted_at IS NULL
    ORDER BY m.sent_at DESC, m.created_at DESC
    LIMIT 1
  ) AS latest
  WHERE c.id = target;

  -- Every message gone is not the same as no messages ever: a thread whose last message was
  -- withdrawn goes back to having no clock rather than keeping a stopped one.
  IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = target AND m.deleted_at IS NULL) THEN
    UPDATE conversations SET last_message_at = NULL, last_direction = NULL WHERE id = target;
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER messages_move_the_thread
  AFTER INSERT OR UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION sw_conversation_last_message();

/**
 * What `trust_level` is allowed to say.
 *
 * It has been `text NOT NULL DEFAULT 'untrusted_external'` since 0003, with the vocabulary living
 * only in `packages/ai`'s `TrustLevel` type. That was survivable while the seed was the sole
 * writer. It stops being survivable the moment the product writes it, because of this line in
 * `listMessages`:
 *
 *     const findings = row.trust_level === 'untrusted_external' ? detectInjection(row.body_text) : []
 *
 * A value outside the vocabulary is not a data-quality problem. It reads as "not untrusted", and
 * the injection scan over content that came from outside the company is silently skipped. A typo
 * would buy an attacker exactly what `transcript-injection.test.ts` exists to prevent.
 *
 * So the list is a constraint, matching `TrustLevel` exactly. Four values rather than the two
 * this table uses: the type is shared with the model layer, and a CHECK that quietly disagreed
 * with it would be a second vocabulary — which is the thing being fixed.
 */
ALTER TABLE messages
  ADD CONSTRAINT messages_trust_level_known
    CHECK (trust_level IN ('trusted_system', 'user_instruction', 'org_data', 'untrusted_external'));

-- "The messages on this thread, newest first", which is the read the trigger above makes on every
-- write. `messages_conversation_idx` is (organization_id, conversation_id, sent_at) ascending and
-- carries no organization in the trigger's query — it has only the conversation to go on.
CREATE INDEX messages_thread_latest_idx
  ON messages (conversation_id, sent_at DESC)
  WHERE deleted_at IS NULL;
