-- 0050 — A send that can be stopped.
--
-- `send_email` returns `recallWindowSeconds` in its own output schema, sets `send_after` to a
-- minute from now, and enqueues the dispatch with `notBefore` on it. The worker reads
-- `recalled_at` before it hands anything to the provider and stops if it is set — the comment
-- there says "a user who changes their mind inside it wins".
--
-- Nothing has ever written `recalled_at`. The window is a delay with no button behind it, and
-- the tool has been telling every caller about a recall that does not exist.
--
-- Three columns and three constraints, and the interesting one is the race.
--
-- **`dispatch_started_at`** is how the row arbitrates between the person and the worker. The
-- worker reads `recalled_at`, then calls the provider — and a recall landing in that gap would
-- have set `recalled_at` on a message that had already gone. The database would then say
-- recalled while the recipient had it, which is the worst of the available lies. So dispatch
-- claims the row first, conditionally, and a recall is refused once the claim is taken. Neither
-- side has to be trusted to check in the right order (ADRs 0028, 0030, 0040, 0047).
--
-- **`recalled_by` / `recall_reason`** because stopping an approved, externally-visible send is
-- a decision about something a person had already agreed to, and the record should say who
-- changed their mind and why (ADRs 0044, 0046).

ALTER TABLE email_sends
  -- Taken by the dispatcher immediately before it hands the message over, and never cleared:
  -- an attempt that reached the provider is a fact about the outside world.
  ADD COLUMN dispatch_started_at timestamptz,
  ADD COLUMN recalled_by uuid REFERENCES users(id),
  ADD COLUMN recall_reason text;

ALTER TABLE email_sends
  -- The guarantee. If the claim above is ever wrong, the write that would store the
  -- contradiction fails instead of storing it.
  ADD CONSTRAINT email_sends_not_both_recalled_and_sent
    CHECK (NOT (recalled_at IS NOT NULL AND sent_at IS NOT NULL)),
  -- NOT VALID, and deliberately. Rolling this migration back drops the two attribution columns,
  -- so a send that was already stopped comes back with `recalled_at` set and nobody named — and
  -- re-applying would then refuse over the product's own seeded data. The check is enforced on
  -- everything written from here on, which is what it is for; inventing a name for a recall that
  -- happened before the column existed would be worse than admitting the row predates it.
  ADD CONSTRAINT email_sends_recall_attributed CHECK (
    (recalled_at IS NULL AND recalled_by IS NULL AND recall_reason IS NULL)
    OR (recalled_at IS NOT NULL AND recalled_by IS NOT NULL
        AND recall_reason IS NOT NULL AND length(btrim(recall_reason)) >= 3)
  ) NOT VALID,
  -- `failed_at` and `error` were the other two columns on this table nothing ever wrote, so a
  -- send that gave up looked exactly like one still waiting. Both halves or neither.
  ADD CONSTRAINT email_sends_failure_says_why
    CHECK ((failed_at IS NULL) = (error IS NULL));

-- What is on its way out, for the screen that offers to stop it. Everything else about this
-- table is looked up by id or by idempotency key.
CREATE INDEX email_sends_in_flight_idx ON email_sends (organization_id, send_after)
  WHERE sent_at IS NULL AND recalled_at IS NULL AND failed_at IS NULL AND deleted_at IS NULL;
