-- 0059 — A promise that became work.
--
-- `commitments.task_id` was added in migration 0010 and nothing has ever written it, while
-- `SELECT_COMMITMENT` reads it into every `CommitmentView` the product builds.
--
-- The ledger already has the hard half. A commitment is detected by the assistant from a
-- message or a transcript, sits as `proposed` until its named owner accepts it, and can then be
-- confirmed, disputed, renegotiated in advance, or completed. What it has never had is the
-- work: you accept "we will confirm the Gothenburg window by Wednesday" and there is no way to
-- turn it into the task you would actually do it with. Then you mark it `kept` by pressing a
-- button, which is a claim about work that never existed anywhere in the system.
--
-- Once a commitment has a task, two rows have to agree — "the task is done" and "the promise
-- was kept" — and that agreement is exactly the kind this codebase does not leave to
-- application memory. One writer decides: **the task is the work**. Completing it is what
-- makes the promise kept, by trigger, for every writer. `respondToCommitment` refuses to mark
-- a linked commitment complete on its own and says to finish the task instead.

-- Only a promise we made can be discharged by our own task. A `they_owe` commitment is the
-- counterparty's to keep — a task about it would be a chase, and completing the chase would
-- say they delivered when all that happened is that we asked. Follow-ups are what that is for.
--
-- Validated rather than NOT VALID: `task_id` is 0010's column, the down script leaves it and
-- any links in it alone, and every existing row has it NULL — so there is no row this cannot
-- be made true of.
ALTER TABLE commitments
  ADD CONSTRAINT commitments_task_is_ours
    CHECK (task_id IS NULL OR direction = 'we_owe');

/**
 * The task discharging a promise belongs to the same organization.
 *
 * The guarantee 0056, 0057 and 0058 each make in their own way: a foreign key to `tasks` says
 * the task exists and nothing about which tenant it is in. A commitment pointing at another
 * organization's task would be discharged by work nobody here can see, and the ledger — which
 * is the record of whether this company keeps its word — would say it was kept.
 */
CREATE OR REPLACE FUNCTION sw_commitment_task_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a commitment can only be discharged by a live task in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Checked when the link arrives, not on every later edit — the split 0057 introduced, for the
-- reason it introduced it: a task can be deleted after the link is made, and a single
-- BEFORE INSERT OR UPDATE trigger would then refuse every future write to the commitment over
-- a column the write never touched.
CREATE TRIGGER commitments_task_same_org_insert
  BEFORE INSERT ON commitments
  FOR EACH ROW WHEN (NEW.task_id IS NOT NULL)
  EXECUTE FUNCTION sw_commitment_task_same_org();

CREATE TRIGGER commitments_task_same_org_update
  BEFORE UPDATE ON commitments
  FOR EACH ROW WHEN (NEW.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM OLD.task_id)
  EXECUTE FUNCTION sw_commitment_task_same_org();

/**
 * Finishing the work keeps the promise.
 *
 * This is the one-writer rule for the pair, and it lives here rather than in `updateTask`
 * because the two rows must agree for every writer — the tool that completes a task on the
 * agent's behalf, the reminder that completes one from a reply, and anything added later that
 * nobody thought to teach about commitments.
 *
 * Only `confirmed` moves. A commitment that is `disputed` is not made true by somebody
 * finishing a task, one already `kept` has nothing to change, and `proposed` never counted in
 * the first place — the ledger's founding rule is that an unaccepted commitment is a
 * suggestion, and a suggestion cannot be kept.
 *
 * Nothing here moves in the other direction. Cancelling the task does not unmake a promise
 * made to somebody outside this company; the promise stands and the ledger goes on saying so.
 */
CREATE OR REPLACE FUNCTION sw_commitment_kept_by_task() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE commitments
  SET status = 'kept', updated_at = now()
  WHERE organization_id = NEW.organization_id
    AND task_id = NEW.id
    AND status = 'confirmed'
    AND deleted_at IS NULL;
  RETURN NULL;
END
$$;

CREATE TRIGGER tasks_completion_keeps_commitment
  AFTER UPDATE ON tasks
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION sw_commitment_kept_by_task();

-- "Which promise does this task discharge", which is the read the trigger makes on every
-- completion, and the one a task page makes to say what it is for.
CREATE INDEX commitments_task_idx
  ON commitments (organization_id, task_id)
  WHERE deleted_at IS NULL AND task_id IS NOT NULL;
