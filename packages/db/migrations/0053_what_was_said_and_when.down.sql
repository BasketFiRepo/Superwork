DROP INDEX IF EXISTS interactions_contact_idx;

ALTER TABLE interactions
  DROP CONSTRAINT IF EXISTS interactions_kind_known,
  DROP CONSTRAINT IF EXISTS interactions_summary_said,
  DROP CONSTRAINT IF EXISTS interactions_about_somebody;
