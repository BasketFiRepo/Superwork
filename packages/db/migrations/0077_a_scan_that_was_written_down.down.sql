DROP INDEX IF EXISTS messages_flagged_idx;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_counts_need_a_scan;

-- What was scanned stays scanned. `sanitized_at` and the counts existed before this migration and
-- the values in them are findings about real correspondence; clearing them to undo a constraint
-- would throw away the record rather than the rule.
