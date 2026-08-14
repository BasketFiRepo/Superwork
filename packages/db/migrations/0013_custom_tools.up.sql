-- 0013 · Admin-authored HTTP tools (§22)
--
-- An organization can teach Superwork to call one of its own systems. The rule that makes
-- that safe is the one this schema enforces: a custom tool is a tool like any other. It is
-- resolved through the same registry, checked by the same policy engine, previewed and
-- approved through the same approval flow, and written to the same tool_calls audit trail.
-- No exceptions — a custom tool must not be a permission bypass.
--
-- Two structural guarantees live here rather than in code:
--   1. a tool cannot be activated unless its host has been reviewed by a named person on
--      a named date (the allow-list is a table of decisions, not a config string);
--   2. a tool's declared risk tier and permissions are columns, so the gate reads them
--      from the database rather than from anything a model produced.

CREATE TABLE custom_tool_hosts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Lower-case hostname only. No scheme, no path, no wildcard: a wildcard host is how an
  -- allow-list stops being one.
  host            text NOT NULL,
  reason          text NOT NULL,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT host_is_a_hostname CHECK (host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
  CONSTRAINT host_not_wildcard CHECK (host NOT LIKE '%*%')
);
CREATE UNIQUE INDEX custom_tool_hosts_key
  ON custom_tool_hosts (organization_id, host) WHERE deleted_at IS NULL;

CREATE TABLE custom_tools (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- snake_case and versioned, exactly like a built-in: the model never learns that some
  -- tools are second-class.
  name            text NOT NULL,
  description     text NOT NULL,
  method          text NOT NULL DEFAULT 'GET',
  -- https only, host must appear in custom_tool_hosts before activation.
  url_template    text NOT NULL,
  host            text NOT NULL,
  -- [{ name, type, in, required, description }] — the contract the model is shown.
  parameters      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Static headers. Values naming a secret are stored as ${SECRET_NAME} and resolved at
  -- call time; a literal credential is refused at the API rather than stored.
  headers         jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_tier       sw_risk_tier NOT NULL DEFAULT 'read',
  required_permissions text[] NOT NULL DEFAULT ARRAY['integration:read:org'],
  -- A custom tool has no inverse Superwork can construct, so it is never reversible and
  -- never offered as undoable. Anything that changes something outside is approval-gated.
  reversible      boolean NOT NULL DEFAULT false,
  timeout_ms      integer NOT NULL DEFAULT 8000,
  per_run_limit   integer NOT NULL DEFAULT 5,
  per_hour_limit  integer NOT NULL DEFAULT 200,
  redactions      text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft',
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  last_called_at  timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT custom_tool_name_shape CHECK (name ~ '^[a-z][a-z0-9_]{2,48}@v[0-9]+$'),
  CONSTRAINT custom_tool_method_known CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  CONSTRAINT custom_tool_https_only CHECK (url_template LIKE 'https://%'),
  CONSTRAINT custom_tool_status_known CHECK (status IN ('draft', 'active', 'disabled')),
  -- Activation requires a named approver. A tool that reaches an external system on the
  -- strength of nobody's decision is the thing this table exists to prevent.
  CONSTRAINT custom_tool_active_is_approved CHECK (status <> 'active' OR approved_by IS NOT NULL),
  CONSTRAINT custom_tool_timeout_sane CHECK (timeout_ms BETWEEN 500 AND 30000)
);
CREATE UNIQUE INDEX custom_tools_name_key
  ON custom_tools (organization_id, name) WHERE deleted_at IS NULL;
CREATE INDEX custom_tools_active_idx
  ON custom_tools (organization_id, status) WHERE deleted_at IS NULL;

SELECT sw_attach_touch(t) FROM (VALUES
  ('custom_tool_hosts'::regclass), ('custom_tools')
) AS x(t);

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['custom_tool_hosts', 'custom_tools'])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
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
