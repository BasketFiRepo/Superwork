-- 0008 · rollback
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
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM superwork_app', t);
  END LOOP;
END
$$;

DROP POLICY IF EXISTS organizations_auth_role ON organizations;
DROP POLICY IF EXISTS memberships_auth_role ON memberships;
DROP POLICY IF EXISTS sessions_auth_role ON sessions;
DROP POLICY IF EXISTS sessions_own ON sessions;
DROP POLICY IF EXISTS users_auth_role ON users;
DROP POLICY IF EXISTS users_tenant_visibility ON users;
DROP POLICY IF EXISTS tenant_isolation ON organizations;

ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM superwork_app, superwork_auth;
REVOKE USAGE ON SCHEMA public FROM superwork_app, superwork_auth;

DROP FUNCTION IF EXISTS sw_current_user();
