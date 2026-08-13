-- 0008 · Row Level Security.
--
-- Isolation is enforced three times (§3.2). This file is layer one: the database.
-- Neither application role holds BYPASSRLS, and neither owns the tables, so the
-- policies below apply unconditionally — a forgotten WHERE clause cannot leak a tenant.
--
--   superwork_app  — the tenant runtime role. Sees exactly one organization, chosen by
--                    the `app.current_org` session variable that TenantContext sets.
--   superwork_auth — the pre-tenant role used only to resolve a login into a session.
--                    Reaches identity tables and nothing else.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'superwork_app') THEN
    CREATE ROLE superwork_app LOGIN PASSWORD 'superwork_dev' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'superwork_auth') THEN
    CREATE ROLE superwork_auth LOGIN PASSWORD 'superwork_dev' NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE superwork_app NOBYPASSRLS;
ALTER ROLE superwork_auth NOBYPASSRLS;

CREATE OR REPLACE FUNCTION sw_current_user() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

GRANT USAGE ON SCHEMA public TO superwork_app, superwork_auth;

-- ---------------------------------------------------------------------------
-- Tenant tables: one generic policy, applied to every table carrying organization_id.
-- Adding a table later without a policy fails the cross-tenant test pack rather than
-- silently shipping an unprotected table.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        AS PERMISSIVE FOR ALL TO superwork_app
        USING (organization_id = sw_current_org())
        WITH CHECK (organization_id = sw_current_org())
    $p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO superwork_app', t);
  END LOOP;
END
$$;

-- The organization row itself is scoped by primary key rather than organization_id.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  AS PERMISSIVE FOR ALL TO superwork_app
  USING (id = sw_current_org())
  WITH CHECK (id = sw_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO superwork_app;

-- ---------------------------------------------------------------------------
-- audit_logs is append-only for the application role (§3.6).
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE ON audit_logs FROM superwork_app;
GRANT SELECT, INSERT ON audit_logs TO superwork_app;

-- ---------------------------------------------------------------------------
-- Global identity tables.
-- ---------------------------------------------------------------------------

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_visibility ON users;
-- The runtime role sees itself plus colleagues in the current organization. Nothing else.
CREATE POLICY users_tenant_visibility ON users
  AS PERMISSIVE FOR ALL TO superwork_app
  USING (
    id = sw_current_user()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.organization_id = sw_current_org()
        AND m.deleted_at IS NULL
    )
  )
  WITH CHECK (id = sw_current_user());
GRANT SELECT, INSERT, UPDATE ON users TO superwork_app;

DROP POLICY IF EXISTS users_auth_role ON users;
CREATE POLICY users_auth_role ON users AS PERMISSIVE FOR ALL TO superwork_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON users TO superwork_auth;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessions_own ON sessions;
CREATE POLICY sessions_own ON sessions
  AS PERMISSIVE FOR ALL TO superwork_app
  USING (user_id = sw_current_user())
  WITH CHECK (user_id = sw_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO superwork_app;

DROP POLICY IF EXISTS sessions_auth_role ON sessions;
CREATE POLICY sessions_auth_role ON sessions AS PERMISSIVE FOR ALL TO superwork_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO superwork_auth;

-- superwork_auth resolves a login to its organizations and nothing more.
DROP POLICY IF EXISTS memberships_auth_role ON memberships;
CREATE POLICY memberships_auth_role ON memberships AS PERMISSIVE FOR SELECT TO superwork_auth USING (true);
GRANT SELECT ON memberships TO superwork_auth;

DROP POLICY IF EXISTS organizations_auth_role ON organizations;
CREATE POLICY organizations_auth_role ON organizations AS PERMISSIVE FOR SELECT TO superwork_auth USING (true);
GRANT SELECT ON organizations TO superwork_auth;

-- Plan limits are global reference data.
GRANT SELECT ON plan_limits TO superwork_app;

-- Sequences and helper functions.
GRANT EXECUTE ON FUNCTION sw_current_org() TO superwork_app, superwork_auth;
GRANT EXECUTE ON FUNCTION sw_current_user() TO superwork_app, superwork_auth;

-- Migration bookkeeping stays with the owner role only.
REVOKE ALL ON schema_migrations FROM superwork_app, superwork_auth;
