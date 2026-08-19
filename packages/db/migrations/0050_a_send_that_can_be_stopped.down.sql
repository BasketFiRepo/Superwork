DROP INDEX IF EXISTS email_sends_in_flight_idx;

ALTER TABLE email_sends
  DROP CONSTRAINT IF EXISTS email_sends_not_both_recalled_and_sent,
  DROP CONSTRAINT IF EXISTS email_sends_recall_attributed,
  DROP CONSTRAINT IF EXISTS email_sends_failure_says_why;

ALTER TABLE email_sends
  DROP COLUMN IF EXISTS dispatch_started_at,
  DROP COLUMN IF EXISTS recalled_by,
  DROP COLUMN IF EXISTS recall_reason;
