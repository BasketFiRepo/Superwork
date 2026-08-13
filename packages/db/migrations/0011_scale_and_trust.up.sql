-- 0011 · Phase 3 — scale, trust and depth
--
-- Three claims have to become answerable from the interface alone (§24, Phase 3):
--   1. what the AI read, proposed, executed and cost last month, per department;
--   2. an agent created, permissioned, simulated and published without an engineer;
--   3. every employee can see what is tracked about them and what was reported to whom.
--
-- The first is a query over rows that already exist. The second and third need storage:
-- change requests and their simulations, and a disclosure record written every time
-- information about a person reaches somebody else.

-- ---------------------------------------------------------------------------
-- Agent change control (§27.4)
-- ---------------------------------------------------------------------------

CREATE TYPE sw_change_status AS ENUM (
  'draft', 'awaiting_approval', 'approved', 'rejected', 'published', 'rolled_back'
);

CREATE TABLE agent_simulations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The configuration that was simulated, not the one live at the time.
  snapshot        jsonb NOT NULL,
  window_from     timestamptz NOT NULL,
  window_to       timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'running',   -- running | succeeded | failed
  -- What it would have done, by tool and by risk tier, with the plans themselves kept
  -- so a reviewer reads the actual proposals rather than a count.
  proposals       jsonb NOT NULL DEFAULT '[]'::jsonb,
  totals          jsonb NOT NULL DEFAULT '{}'::jsonb,
  findings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_cents      numeric(12,4) NOT NULL DEFAULT 0,
  simulated       boolean NOT NULL DEFAULT true,
  finished_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT simulation_window_ordered CHECK (window_to > window_from)
);
CREATE INDEX agent_simulations_agent_idx ON agent_simulations (organization_id, agent_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE agent_change_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The version this change is proposed against; publishing a stale request fails.
  base_version    integer NOT NULL DEFAULT 0,
  proposed        jsonb NOT NULL,
  -- Filled at request time so the reviewer sees what changes, not two blobs.
  diff            jsonb NOT NULL DEFAULT '[]'::jsonb,
  justification   text NOT NULL,
  status          sw_change_status NOT NULL DEFAULT 'draft',
  simulation_id   uuid REFERENCES agent_simulations(id) ON DELETE SET NULL,
  requested_by    uuid NOT NULL REFERENCES users(id),
  -- Never the requester: widening an agent's reach needs a second pair of eyes (§27.4).
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_note   text,
  published_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT change_second_approver CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX agent_change_requests_open_idx ON agent_change_requests (organization_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

-- Autopilot is only ever allowed inside numbers a human set, and the caps are columns
-- rather than prompt text so the gate can enforce them (§27.6).
ALTER TABLE agents
  ADD COLUMN autopilot_daily_action_cap integer NOT NULL DEFAULT 10,
  ADD COLUMN autopilot_weekly_cost_cap_cents integer NOT NULL DEFAULT 500,
  ADD COLUMN autopilot_paused_until timestamptz,
  ADD COLUMN digest_day integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT autopilot_caps_positive CHECK (
    autopilot_daily_action_cap > 0 AND autopilot_weekly_cost_cap_cents > 0
  ),
  ADD CONSTRAINT digest_day_valid CHECK (digest_day BETWEEN 0 AND 6);

CREATE TABLE agent_digests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The accountable human, who is the only required recipient.
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_from     timestamptz NOT NULL,
  period_to       timestamptz NOT NULL,
  facts           jsonb NOT NULL,
  narrative       text NOT NULL,
  cost_cents      numeric(12,4) NOT NULL DEFAULT 0,
  read_at         timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX agent_digests_period ON agent_digests (organization_id, agent_id, period_from)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Disclosures: nothing about a person moves without a row (§29.3)
-- ---------------------------------------------------------------------------

CREATE TABLE disclosures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Who the information is about.
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who received it. A recipient outside the product is named in `recipient_label`.
  recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_label text NOT NULL,
  kind            text NOT NULL,   -- weekly_digest | department_report | export | manager_rollup | api_read
  summary         text NOT NULL,
  fields          text[] NOT NULL DEFAULT '{}',
  -- The person sees this at the same time as the recipient; a delayed disclosure is a
  -- covert one.
  visible_to_subject boolean NOT NULL DEFAULT true,
  authorized_by   uuid REFERENCES users(id),
  authorization_note text,
  agent_run_id    uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  source_type     text,
  source_id       uuid,
  disclosed_at    timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  -- §29.5: an individual's activity may only leave for HR with a logged authorization.
  CONSTRAINT export_requires_authorization CHECK (
    kind <> 'export' OR (authorized_by IS NOT NULL AND authorization_note IS NOT NULL)
  ),
  -- There is no such thing as a disclosure the subject may not see.
  CONSTRAINT disclosure_never_covert CHECK (visible_to_subject = true)
);
CREATE INDEX disclosures_subject_idx ON disclosures (organization_id, subject_user_id, disclosed_at DESC)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Integrations, identity and residency (§13, §23)
-- ---------------------------------------------------------------------------

CREATE TABLE integration_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Capability-shaped, never vendor-shaped: features ask for `chat`, not for Slack.
  capability      text NOT NULL,   -- email | calendar | storage | chat | finance | crm | identity
  vendor          text NOT NULL,
  mode            sw_runtime_mode NOT NULL DEFAULT 'mock',
  status          text NOT NULL DEFAULT 'connected',  -- connected | degraded | disconnected | revoked
  scopes          text[] NOT NULL DEFAULT '{}',
  external_account text,
  health          jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at    timestamptz,
  last_error      text,
  connected_by    uuid REFERENCES users(id),
  connected_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX integration_connections_capability
  ON integration_connections (organization_id, capability) WHERE deleted_at IS NULL;

CREATE TABLE identity_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sso_enabled     boolean NOT NULL DEFAULT false,
  sso_provider    text,
  sso_metadata_url text,
  -- Domains whose users may be provisioned automatically; empty means nobody.
  verified_domains text[] NOT NULL DEFAULT '{}',
  jit_provisioning boolean NOT NULL DEFAULT false,
  default_role    sw_role NOT NULL DEFAULT 'member',
  scim_enabled    boolean NOT NULL DEFAULT false,
  scim_token_hash text,
  scim_token_prefix text,
  last_sync_at    timestamptz,
  last_sync_summary jsonb,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX identity_settings_org ON identity_settings (organization_id) WHERE deleted_at IS NULL;

-- Residency is a property of the organization, checked before a provider is used.
ALTER TABLE organizations
  ADD COLUMN data_region text NOT NULL DEFAULT 'eu',
  ADD COLUMN allowed_regions text[] NOT NULL DEFAULT ARRAY['eu'],
  ADD CONSTRAINT data_region_allowed CHECK (data_region = ANY (allowed_regions));

-- ---------------------------------------------------------------------------
-- Public API and MCP (§22)
--
-- Admin-authored HTTP tools are deliberately absent: the authoring flow, the host
-- allowlist review and the sandbox they need are Phase 4 work, and a table nothing writes
-- to is a promise the product has not kept.
-- ---------------------------------------------------------------------------

CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  -- Shown in the UI so a key is recognisable; the secret itself is never stored.
  prefix          text NOT NULL,
  secret_hash     text NOT NULL,
  scopes          text[] NOT NULL DEFAULT '{}',
  -- Every key acts as a person: an API call is never an actor without a principal.
  principal_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rate_limit_per_minute integer NOT NULL DEFAULT 60,
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT api_key_rate_limit_positive CHECK (rate_limit_per_minute > 0)
);
CREATE UNIQUE INDEX api_keys_prefix ON api_keys (prefix);

CREATE TABLE api_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  api_key_id      uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  method          text NOT NULL,
  path            text NOT NULL,
  status          integer NOT NULL,
  duration_ms     integer,
  scope_used      text,
  error_code      text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX api_requests_key_idx ON api_requests (organization_id, api_key_id, occurred_at DESC);

SELECT sw_attach_touch(t) FROM (VALUES
  ('agent_simulations'::regclass), ('agent_change_requests'), ('agent_digests'), ('disclosures'),
  ('integration_connections'), ('identity_settings'), ('api_keys'), ('api_requests')
) AS x(t);

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'agent_simulations', 'agent_change_requests', 'agent_digests', 'disclosures',
    'integration_connections', 'identity_settings', 'api_keys', 'api_requests'
  ])
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

-- An API key is resolved before any tenant is known, so the pre-tenant role reads the
-- key table only — exactly as it reads the users table to sign somebody in.
GRANT SELECT ON public.api_keys TO superwork_auth;
CREATE POLICY api_key_lookup ON public.api_keys
  AS PERMISSIVE FOR SELECT TO superwork_auth USING (true);
