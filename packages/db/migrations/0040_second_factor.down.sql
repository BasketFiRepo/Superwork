ALTER TABLE sessions DROP COLUMN IF EXISTS mfa_satisfied_at;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_mfa_needs_confirmed_secret;

ALTER TABLE users
  DROP COLUMN IF EXISTS mfa_recovery_hashes,
  DROP COLUMN IF EXISTS mfa_last_counter,
  DROP COLUMN IF EXISTS mfa_confirmed_at,
  DROP COLUMN IF EXISTS mfa_secret;
