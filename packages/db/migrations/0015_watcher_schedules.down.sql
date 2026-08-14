-- 0015 · rollback

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_one_target;

DROP INDEX IF EXISTS schedules_target_key_name;
