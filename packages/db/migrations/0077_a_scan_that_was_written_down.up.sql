-- 0077 — A scan that was written down.
--
-- Two scans run over every inbound message: `sanitizeMessage` strips remote images, scripts and
-- embeds, and `detectInjection` looks for an instruction aimed at the assistant. Both have run
-- since Phase 2. Neither was ever recorded on arrival.
--
--   • `messages.sanitized_at`, `remote_image_count` and `link_count` had no writer at all, so
--     nothing could be asked which correspondence carried a script or a tracking pixel — the
--     answer existed only for as long as it took to render one thread;
--   • `injection_flagged` had exactly one writer: `ground.ts`, which sets it when an *agent*
--     happens to read the message during a run.
--
-- The second is the sharp one, because two screens disagree about the same message. The thread
-- view re-scans on read and shows the finding; the inbox list reads `injection_flagged` straight
-- out of the table, because an aggregate over conversations cannot re-scan. So a thread carrying
-- an injection attempt shows **no flag in the list** until some agent grounds on it, and the list
-- is the screen triage works from.
--
-- No new columns. The columns were right; nothing wrote them.

-- ---------------------------------------------------------------------------------------------
-- A count is a finding, and a finding needs a scan behind it

-- `sanitized_at IS NULL` is the honest state of every message filed before this migration: not
-- scanned on arrival, rather than scanned and clean. This says the counts cannot claim otherwise —
-- a row with findings and no scan behind them is a number nobody can source.
ALTER TABLE messages
  ADD CONSTRAINT messages_counts_need_a_scan CHECK (
    sanitized_at IS NOT NULL OR (remote_image_count = 0 AND link_count = 0)
  );

-- ---------------------------------------------------------------------------------------------
-- The question the inbox list asks of every thread it renders

-- `EXISTS (SELECT 1 FROM messages WHERE conversation_id = … AND injection_flagged)`, once per
-- conversation on the list. It has been a scan of the conversation's messages; now that the flag
-- is written on arrival rather than by an agent's side effect, there will be rows to find, and
-- this is the index that finds them without reading the rest of the thread.
CREATE INDEX messages_flagged_idx
  ON messages (conversation_id)
  WHERE injection_flagged AND deleted_at IS NULL;
