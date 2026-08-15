-- 0031 — Two things the agent writes that nobody could read.
--
-- `task_comments` is written by `comment_on_task@v1`, whose own description says the comment
-- is "attributed to the agent by name. Never post as if a person wrote it." Nothing reads
-- the table, so the agent has been leaving notes on people's tasks that no screen shows —
-- and no person could add one either, because the only writer is a tool. A `mentions` array
-- has been on the row since Phase 0 and has never been populated, so mentioning somebody
-- did nothing.
--
-- `follow_ups` is written by `create_follow_up@v1`: "Record a dated follow-up on a
-- conversation or account so it resurfaces if no reply arrives." It never resurfaced.
-- Nothing reads the table, no worker sweeps it, and the status column has only ever held
-- 'open' and 'cancelled'. Every follow-up the agent has ever recorded is still open.

-- Who wrote it, in the row rather than in the reader's guess. `actor_type` distinguishes a
-- person from an agent; `agent_id` says *which* agent, which is what "attributed by name"
-- requires and what the tool never filled in.
ALTER TABLE task_comments
  ADD CONSTRAINT task_comments_agent_named
    CHECK (actor_type <> 'agent' OR created_by IS NOT NULL);

-- A comment nobody wrote is not a comment.
ALTER TABLE task_comments
  ADD CONSTRAINT task_comments_body_present CHECK (length(btrim(body)) > 0);

/**
 * Everybody mentioned is a member of the same organization.
 *
 * A mention now produces a notification, which makes the array an addressing mechanism.
 * Addressing that can name a row outside the tenant is the shape §3.2 exists to stop, and
 * an array column has no foreign key to lean on.
 */
CREATE OR REPLACE FUNCTION sw_task_comment_mentions_in_org() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  outsiders integer;
BEGIN
  IF array_length(NEW.mentions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO outsiders
  FROM unnest(NEW.mentions) AS m(user_id)
  WHERE NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = m.user_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  );

  IF outsiders > 0 THEN
    RAISE EXCEPTION 'a comment can only mention members of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER task_comments_mentions_in_org
  BEFORE INSERT OR UPDATE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION sw_task_comment_mentions_in_org();

-- The three states a follow-up can be in. `status` was free text and only two of these were
-- ever written; nothing could mark one done because nothing could see one.
ALTER TABLE follow_ups
  ADD CONSTRAINT follow_ups_status_known CHECK (status IN ('open', 'done', 'cancelled'));

-- How it ended, and who ended it. A follow-up that closed itself because the customer
-- replied is a different outcome from one somebody decided was finished, and the difference
-- is the whole reason the agent recorded it.
ALTER TABLE follow_ups
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by uuid REFERENCES users(id),
  ADD COLUMN resolution text,
  ADD COLUMN resolution_note text,
  ADD CONSTRAINT follow_ups_resolution_known
    CHECK (resolution IS NULL OR resolution IN ('done', 'cancelled', 'replied')),
  -- A closed follow-up says when it closed; an open one has not.
  ADD CONSTRAINT follow_ups_closed_has_time
    CHECK ((status = 'open') = (resolved_at IS NULL));

-- One open follow-up per conversation. Two agents recording "chase this on Friday" against
-- the same thread is two people chasing the same customer.
CREATE UNIQUE INDEX follow_ups_one_open_per_conversation
  ON follow_ups (conversation_id)
  WHERE deleted_at IS NULL AND status = 'open' AND conversation_id IS NOT NULL;

-- The read the owner's screen does: what is waiting for me, soonest first.
CREATE INDEX follow_ups_owner_idx
  ON follow_ups (organization_id, owner_id, due_at)
  WHERE deleted_at IS NULL AND status = 'open';

-- One notification per follow-up, so a sweep that runs every few minutes tells its owner
-- once rather than every time it passes. The same shape as the one nudges use.
CREATE UNIQUE INDEX notifications_one_per_follow_up
  ON notifications (entity_id)
  WHERE deleted_at IS NULL AND entity_type = 'follow_up';

-- A follow-up coming due now tells its owner, which is a notification like any other.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention'
    ));
