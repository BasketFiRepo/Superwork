-- 0016 · rollback

ALTER TABLE audit_logs DROP COLUMN IF EXISTS stepped_up_at;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS step_up_locked_until,
  DROP COLUMN IF EXISTS step_up_failures,
  DROP COLUMN IF EXISTS stepped_up_at;
