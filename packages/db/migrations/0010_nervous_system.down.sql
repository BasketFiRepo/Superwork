-- 0010 · rollback
ALTER TABLE commitments
  DROP COLUMN IF EXISTS task_id,
  DROP COLUMN IF EXISTS disputed_reason,
  DROP COLUMN IF EXISTS source_excerpt,
  DROP COLUMN IF EXISTS source_segment_id;
DROP INDEX IF EXISTS commitments_owner_idx;

DROP TABLE IF EXISTS notification_preferences CASCADE;
DROP TABLE IF EXISTS briefings CASCADE;
DROP TABLE IF EXISTS interactions CASCADE;
DROP TABLE IF EXISTS contact_merge_candidates CASCADE;
DROP TABLE IF EXISTS decisions CASCADE;
DROP TABLE IF EXISTS transcript_segments CASCADE;
DROP TABLE IF EXISTS transcripts CASCADE;
DROP TABLE IF EXISTS meeting_participants CASCADE;
DROP TABLE IF EXISTS meetings CASCADE;
DROP TABLE IF EXISTS email_accounts CASCADE;

ALTER TABLE companies
  DROP COLUMN IF EXISTS check_in_days,
  DROP COLUMN IF EXISTS last_interaction_at,
  DROP COLUMN IF EXISTS size_band;

ALTER TABLE contacts
  DROP COLUMN IF EXISTS next_step,
  DROP COLUMN IF EXISTS next_step_at,
  DROP COLUMN IF EXISTS merged_into_contact_id,
  DROP COLUMN IF EXISTS seniority;

ALTER TABLE messages
  DROP COLUMN IF EXISTS sanitized_at,
  DROP COLUMN IF EXISTS link_count,
  DROP COLUMN IF EXISTS remote_image_count;

DROP INDEX IF EXISTS conversations_queue_idx;
DROP INDEX IF EXISTS conversations_triage_idx;
ALTER TABLE conversations
  DROP COLUMN IF EXISTS assigned_to,
  DROP COLUMN IF EXISTS waiting_since,
  DROP COLUMN IF EXISTS waiting_for,
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS triaged_by_agent_run_id,
  DROP COLUMN IF EXISTS triaged_at,
  DROP COLUMN IF EXISTS sentiment,
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS category;

DROP TYPE IF EXISTS sw_briefing_kind;
DROP TYPE IF EXISTS sw_meeting_status;
DROP TYPE IF EXISTS sw_conversation_category;
