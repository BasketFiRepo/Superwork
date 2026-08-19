-- The array comes back empty. Rolling back cannot restore exceptions it is also dropping the
-- record of, and inventing entries for it would be worse than an organization noticing that its
-- exceptions are gone.
ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS extra_permissions text[] NOT NULL DEFAULT '{}';

DROP TABLE IF EXISTS permission_grants;
DROP FUNCTION IF EXISTS sw_grantable_permission(text);
