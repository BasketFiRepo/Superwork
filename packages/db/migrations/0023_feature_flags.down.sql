-- 0023 · rollback

DROP INDEX IF EXISTS feature_flag_lookup_idx;
ALTER TABLE feature_flag_overrides DROP COLUMN IF EXISTS set_by;
ALTER TABLE feature_flag_overrides DROP COLUMN IF EXISTS reason;
ALTER TABLE feature_flag_overrides DROP CONSTRAINT IF EXISTS feature_flag_known;
