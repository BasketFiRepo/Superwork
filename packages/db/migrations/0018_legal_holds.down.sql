-- 0018 · rollback

ALTER TABLE retention_policies DROP COLUMN IF EXISTS last_held;
DROP TABLE IF EXISTS legal_holds CASCADE;
