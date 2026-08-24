-- 0076 — Somebody who signed in with the directory.
--
-- `identity_settings.sso_metadata_url` is read into `IdentitySettings` on every load of the
-- identity screen and written by **nothing**. The reason it has no writer turns out not to be an
-- oversight in a form: there is nowhere for the value to be used, because
--
--     IdentityProvider.verifyAssertion(assertion): Promise<{ email, externalId } | null>
--
-- has a mock and **no consumer**. Nothing in the product has ever called it. So:
--
--   • `sso_enabled` — "Allow signing in with the directory" — is a switch that changes nothing,
--     because there is no sign-in to allow;
--   • `jit_provisioning` — "Create people on first sign-in" — has no first sign-in to act on. It
--     is validated when saved and read by nothing afterwards;
--   • `sso_metadata_url` has no writer because nothing would read one.
--
-- That is ADR 0084's shape a third time: an abstraction with a mock and no consumer, and a
-- cluster of columns that look like an integration nobody built rather than the smaller thing
-- they are. This migration is the schema half of building the consumer.

-- ---------------------------------------------------------------------------------------------
-- SSO that is on has a source

-- An assertion is a claim signed by somebody. The metadata URL is where that somebody's signing
-- key and endpoints are published — so "single sign-on is enabled" without one is a statement
-- with no source behind it, and `verifyAssertion` would be trusting whatever arrived.
--
-- Enforced in the database rather than only in the repository because the two halves of this pair
-- are exactly the kind that drift: a later screen setting one and not the other reads as working.
UPDATE identity_settings
   SET sso_enabled = false
 WHERE sso_enabled = true AND (sso_metadata_url IS NULL OR length(btrim(sso_metadata_url)) = 0);

ALTER TABLE identity_settings
  ADD CONSTRAINT identity_sso_needs_metadata CHECK (
    sso_enabled = false OR (sso_metadata_url IS NOT NULL AND length(btrim(sso_metadata_url)) > 0)
  );

-- ---------------------------------------------------------------------------------------------
-- What the pre-tenant role may see, and the one thing it may write

-- `superwork_auth` exists to turn a login into a session and to do nothing else (migration 0008).
-- A directory sign-in needs two things it has never had, and both are granted as narrowly as the
-- act requires.

-- It has to know whether this organization accepts a directory sign-in at all, and from which
-- domains. Read-only: nothing about a sign-in changes a setting.
CREATE POLICY identity_settings_auth_role ON identity_settings
  AS PERMISSIVE FOR SELECT TO superwork_auth USING (true);
GRANT SELECT ON identity_settings TO superwork_auth;

-- And, when just-in-time provisioning is on, it has to be able to add the person who just
-- arrived. This is the one write, and the policy is the guarantee rather than the code that
-- calls it: **a membership created by the pre-tenant role can never be an owner or an admin,
-- and can never arrive already inactive.**
--
-- `updateIdentitySettings` refuses to store `owner` or `admin` as the default role, so this says
-- the same thing twice on purpose. The application check can be edited by anybody who edits the
-- file; this one holds even if the row said otherwise, which is what makes "a stranger with an
-- assertion cannot become an administrator" a property of the system rather than of a function.
CREATE POLICY memberships_auth_provision ON memberships
  AS PERMISSIVE FOR INSERT TO superwork_auth
  WITH CHECK (
    role <> 'owner'::sw_role AND role <> 'admin'::sw_role AND status = 'active'
  );
GRANT INSERT ON memberships TO superwork_auth;
