-- 0001 · Foundation: extensions, tenancy, identity, metering.
-- Every tenant table carries the standard column set (§2.4):
--   id, organization_id, created_at, updated_at, created_by, deleted_at, version

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Bumps updated_at and the optimistic-concurrency version on every UPDATE.
CREATE OR REPLACE FUNCTION sw_touch_row() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Reads the tenant from the session variable set by TenantContext. RLS depends on it.
CREATE OR REPLACE FUNCTION sw_current_org() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION sw_attach_touch(tbl regclass) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION sw_touch_row()',
    'touch_' || replace(tbl::text, '.', '_'), tbl);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------

CREATE TYPE sw_role AS ENUM ('owner', 'admin', 'manager', 'member', 'viewer', 'guest', 'service');
CREATE TYPE sw_actor_type AS ENUM ('user', 'agent', 'system', 'integration');
CREATE TYPE sw_sensitivity AS ENUM ('public', 'internal', 'confidential', 'restricted');
CREATE TYPE sw_runtime_mode AS ENUM ('mock', 'sandbox', 'live');
CREATE TYPE sw_plan_tier AS ENUM ('free', 'team', 'business', 'enterprise');

-- ---------------------------------------------------------------------------
-- Global identity (not tenant-scoped: a user is one identity across orgs)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  name            text NOT NULL,
  avatar_url      text,
  password_hash   text,
  timezone        text NOT NULL DEFAULT 'UTC',
  locale          text NOT NULL DEFAULT 'en-GB',
  mfa_enabled     boolean NOT NULL DEFAULT false,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
-- Emails are compared case-insensitively without requiring the citext extension.
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE organizations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text NOT NULL,
  industry          text,
  timezone          text NOT NULL DEFAULT 'UTC',
  currency          char(3) NOT NULL DEFAULT 'GBP',
  plan_tier         sw_plan_tier NOT NULL DEFAULT 'free',
  -- Organization profile injected into the stable, cacheable prompt prefix (§7.5).
  profile           jsonb NOT NULL DEFAULT '{}'::jsonb,
  glossary          jsonb NOT NULL DEFAULT '[]'::jsonb,
  onboarding_state  jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_kill_switch boolean NOT NULL DEFAULT false,
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  deleted_at        timestamptz,
  version           integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX organizations_slug_key ON organizations (lower(slug)) WHERE deleted_at IS NULL;

CREATE TABLE departments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES departments(id),
  name            text NOT NULL,
  -- Materialized path for subtree filtering without recursive CTEs (§26.1).
  path            text NOT NULL DEFAULT '',
  depth           integer NOT NULL DEFAULT 0,
  timezone        text,
  holiday_calendar text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX departments_org_path_idx ON departments (organization_id, path);

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            sw_role NOT NULL DEFAULT 'member',
  department_id   uuid REFERENCES departments(id),
  title           text,
  -- Extra permission strings granted beyond the role baseline.
  extra_permissions text[] NOT NULL DEFAULT '{}',
  working_hours   jsonb NOT NULL DEFAULT '{"start":"09:00","end":"17:30","days":[1,2,3,4,5]}'::jsonb,
  status          text NOT NULL DEFAULT 'active',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX memberships_org_user_key ON memberships (organization_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE deleted_at IS NULL;

CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES departments(id),
  name            text NOT NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);

CREATE TABLE team_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX team_members_key ON team_members (team_id, user_id) WHERE deleted_at IS NULL;

-- Functional and dotted-line reporting. A single manager_id column is wrong at scale (§26.1).
CREATE TABLE reporting_relationships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL DEFAULT 'functional',
  scope_entity_type text,
  scope_entity_id uuid,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT reporting_no_self CHECK (person_id <> manager_id)
);
CREATE INDEX reporting_person_idx ON reporting_relationships (organization_id, person_id) WHERE deleted_at IS NULL;

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  user_agent      text,
  ip              inet,
  expires_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           text NOT NULL,
  role            sw_role NOT NULL DEFAULT 'member',
  department_id   uuid REFERENCES departments(id),
  token_hash      text NOT NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- Configuration, plans and metering
-- ---------------------------------------------------------------------------

CREATE TABLE plan_limits (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier                        sw_plan_tier NOT NULL UNIQUE,
  seats                       integer,
  agent_runs_per_month        integer,
  ai_spend_cap_cents          integer,
  per_user_daily_spend_cap_cents integer,
  documents_indexed           integer,
  storage_gb                  integer,
  workflow_runs_per_month     integer,
  autopilot_allowed           boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     integer NOT NULL DEFAULT 1
);

CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tier               sw_plan_tier NOT NULL DEFAULT 'free',
  seats_purchased    integer NOT NULL DEFAULT 3,
  period_start       timestamptz NOT NULL DEFAULT now(),
  period_end         timestamptz,
  ai_spend_cap_cents integer,
  status             text NOT NULL DEFAULT 'active',
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1
);

CREATE TABLE usage_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES departments(id),
  user_id         uuid REFERENCES users(id),
  agent_run_id    uuid,
  unit            text NOT NULL,          -- agent_run | tool_call | tokens_in | tokens_out | document_indexed | workflow_run
  quantity        numeric(18,4) NOT NULL,
  cost_cents      numeric(12,4) NOT NULL DEFAULT 0,
  model           text,
  task_class      text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX usage_records_org_time_idx ON usage_records (organization_id, occurred_at DESC);
CREATE INDEX usage_records_run_idx ON usage_records (agent_run_id);

CREATE TABLE feature_flag_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  flag            text NOT NULL,
  enabled         boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX feature_flag_scope_key
  ON feature_flag_overrides (organization_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), flag)
  WHERE deleted_at IS NULL;

-- §29.5 — prohibited monitoring configurations are impossible to store, not merely discouraged.
CREATE TABLE monitoring_policies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  jurisdiction_profile     text NOT NULL DEFAULT 'strict',
  individual_scoring_enabled boolean NOT NULL DEFAULT false,
  screen_or_keystroke_monitoring boolean NOT NULL DEFAULT false,
  covert_monitoring        boolean NOT NULL DEFAULT false,
  automated_employment_decisions boolean NOT NULL DEFAULT false,
  read_private_dms         boolean NOT NULL DEFAULT false,
  no_surprises_review_hours integer NOT NULL DEFAULT 24,
  nudge_budget_per_person_per_day integer NOT NULL DEFAULT 3,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES users(id),
  deleted_at               timestamptz,
  version                  integer NOT NULL DEFAULT 1,
  CONSTRAINT monitoring_prohibited_by_design CHECK (
    individual_scoring_enabled = false
    AND screen_or_keystroke_monitoring = false
    AND covert_monitoring = false
    AND automated_employment_decisions = false
    AND read_private_dms = false
  )
);
CREATE UNIQUE INDEX monitoring_policies_org_key ON monitoring_policies (organization_id) WHERE deleted_at IS NULL;

SELECT sw_attach_touch(t) FROM (VALUES
  ('users'::regclass), ('organizations'), ('departments'), ('memberships'), ('teams'), ('team_members'),
  ('reporting_relationships'), ('sessions'), ('invitations'), ('plan_limits'), ('subscriptions'),
  ('usage_records'), ('feature_flag_overrides'), ('monitoring_policies')
) AS x(t);
