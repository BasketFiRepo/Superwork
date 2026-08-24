REVOKE INSERT ON memberships FROM superwork_auth;
DROP POLICY IF EXISTS memberships_auth_provision ON memberships;

REVOKE SELECT ON identity_settings FROM superwork_auth;
DROP POLICY IF EXISTS identity_settings_auth_role ON identity_settings;

ALTER TABLE identity_settings DROP CONSTRAINT IF EXISTS identity_sso_needs_metadata;

-- The `sso_enabled` rows this migration turned off are left off. They were switches that decided
-- nothing before it and would decide nothing after it; turning them back on would be inventing a
-- decision nobody made.
