-- 0014 · rollback

ALTER TABLE schedules
  DROP COLUMN IF EXISTS skipped_total,
  DROP COLUMN IF EXISTS last_skipped_reason,
  DROP COLUMN IF EXISTS last_skipped_at;

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_catch_up_known;

DROP INDEX IF EXISTS schedules_target_key;
