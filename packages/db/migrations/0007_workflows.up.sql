-- 0007 · Workflow engine: versioned DAG, durable runs, dry-run simulation.

CREATE TYPE sw_workflow_status AS ENUM ('draft', 'active', 'paused', 'archived');
CREATE TYPE sw_workflow_run_status AS ENUM (
  'queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'simulated'
);

CREATE TABLE workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  -- Mandatory owner: an automation with no accountable human cannot be activated.
  owner_user_id   uuid REFERENCES users(id),
  status          sw_workflow_status NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  max_concurrent_runs integer NOT NULL DEFAULT 1,
  daily_action_cap integer NOT NULL DEFAULT 100,
  -- First activation is blocked until a simulation has passed (§10.2).
  last_simulation_id uuid,
  simulated_ok    boolean NOT NULL DEFAULT false,
  template_key    text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX workflows_org_status_idx ON workflows (organization_id, status) WHERE deleted_at IS NULL;

CREATE TABLE workflow_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id     uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  -- { trigger, nodes[], edges[] } — schema-validated before persistence.
  graph           jsonb NOT NULL,
  readback        text NOT NULL DEFAULT '',
  detected_risks  jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at    timestamptz,
  published_by    uuid REFERENCES users(id),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX workflow_versions_key ON workflow_versions (workflow_id, ordinal);

ALTER TABLE workflows ADD CONSTRAINT workflows_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES workflow_versions(id) ON DELETE SET NULL;

CREATE TABLE workflow_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id     uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id uuid NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  status          sw_workflow_run_status NOT NULL DEFAULT 'queued',
  trigger         text NOT NULL DEFAULT 'manual',
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Simulated runs execute against real data with all side effects suppressed.
  simulated       boolean NOT NULL DEFAULT false,
  is_replay       boolean NOT NULL DEFAULT false,
  run_depth       integer NOT NULL DEFAULT 0,
  agent_run_ids   uuid[] NOT NULL DEFAULT '{}',
  cost_cents      numeric(12,4) NOT NULL DEFAULT 0,
  error           text,
  idempotency_key text NOT NULL,
  started_at      timestamptz,
  finished_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX workflow_runs_idempotency_key ON workflow_runs (organization_id, idempotency_key);
CREATE INDEX workflow_runs_org_idx ON workflow_runs (organization_id, workflow_id, created_at DESC);

ALTER TABLE workflows ADD CONSTRAINT workflows_last_simulation_fk
  FOREIGN KEY (last_simulation_id) REFERENCES workflow_runs(id) ON DELETE SET NULL;

CREATE TABLE workflow_step_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         text NOT NULL,
  node_type       text NOT NULL,
  ordinal         integer NOT NULL,
  status          text NOT NULL DEFAULT 'queued',
  input           jsonb NOT NULL DEFAULT '{}'::jsonb,
  output          jsonb,
  would_have      jsonb,                  -- populated on simulated runs instead of acting
  error           text,
  duration_ms     integer,
  cost_cents      numeric(12,4) NOT NULL DEFAULT 0,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX workflow_step_runs_idx ON workflow_step_runs (organization_id, workflow_run_id, ordinal);

CREATE TABLE schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            text NOT NULL,          -- workflow | watcher | briefing | report
  target_id       uuid,
  target_key      text,
  cron            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'UTC',
  enabled         boolean NOT NULL DEFAULT true,
  catch_up_policy text NOT NULL DEFAULT 'run_once',  -- skip_missed | run_once | run_all
  last_run_at     timestamptz,
  next_run_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX schedules_due_idx ON schedules (enabled, next_run_at) WHERE deleted_at IS NULL;

SELECT sw_attach_touch(t) FROM (VALUES
  ('workflows'::regclass), ('workflow_versions'), ('workflow_runs'), ('workflow_step_runs'), ('schedules')
) AS x(t);
