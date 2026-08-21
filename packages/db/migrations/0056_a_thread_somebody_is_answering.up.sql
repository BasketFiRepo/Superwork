-- 0056 — A thread somebody is answering.
--
-- `conversations.assigned_to` has existed since migration 0010 and nothing has ever written it.
-- Three places read it:
--
--   The inbox's **"My work"** view: `WHERE conv.owner_id = $me OR conv.assigned_to = $me`. A filter
--   the product offers on its busiest screen, half of which could never match anything.
--   The **personal record** counts "conversations about you" as `owner_id = you OR assigned_to =
--   you` — a number in the transparency report that was short by every thread anybody had ever
--   meant to hand over.
--   And `scopeSatisfied('own')` accepts `assigneeId`, so an assignment is the thing that would
--   let somebody act on a thread they do not own — except that no assignment could be made.
--
-- The whole feature was a column, a filter and a policy branch with no way to put a value in.
--
-- Attribution without a reason, deliberately. An assignment is routine — the most common act on
-- an inbox — and requiring a sentence for each one would be friction on the wrong control. But
-- "why is this mine?" is a real question, so who handed it over and when are recorded. Contrast
-- ADR 0061, where the classification *is* the decision and the reason is the point of it.

ALTER TABLE conversations
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN assigned_by uuid REFERENCES users(id);

-- An assignment names who made it. Unassigned rows carry none of the three.
--
-- NOT VALID, for the reason ADRs 0054 and 0061 recorded: the down migration drops the two
-- attribution columns and leaves `assigned_to` where it is, so re-applying over a database where
-- somebody had assigned a thread would meet a row this cannot be made true of — the record of who
-- did it no longer exists. It holds for every write from here.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_assignment_attributed
    CHECK (
      assigned_to IS NULL
      OR (assigned_by IS NOT NULL AND assigned_at IS NOT NULL)
    ) NOT VALID;

/**
 * A thread is handed to somebody who is here.
 *
 * The same guarantee `sw_task_watcher_same_org` makes about a watch, for the same reason: a
 * foreign key to `users` says the person exists, and says nothing at all about whether they are a
 * member of *this* organization. Assigning a thread to somebody in another tenant would put it in
 * a "My work" view they can never open, and the row would look perfectly ordinary.
 */
CREATE OR REPLACE FUNCTION sw_conversation_assignee_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = NEW.assigned_to AND organization_id = NEW.organization_id
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a thread can only be assigned to a member of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_assignee_same_org
  BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION sw_conversation_assignee_same_org();

-- "What is mine to answer", which is the read the busiest screen here actually makes.
CREATE INDEX conversations_assigned_idx
  ON conversations (organization_id, assigned_to)
  WHERE deleted_at IS NULL AND assigned_to IS NOT NULL;
