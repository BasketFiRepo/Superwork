-- 0006 · The agent subsystem: registry, durable runs, provenance, memory, insights.

CREATE TYPE sw_agent_mode AS ENUM ('ask', 'assist', 'execute', 'autopilot');
CREATE TYPE sw_agent_status AS ENUM ('draft', 'staged', 'active', 'paused', 'retired');
CREATE TYPE sw_run_status AS ENUM (
  'queued', 'planning', 'awaiting_approval', 'running', 'succeeded', 'failed',
  'cancelled', 'aborted_by_admin', 'budget_exceeded', 'undone'
);
CREATE TYPE sw_step_status AS ENUM (
  'queued', 'running', 'succeeded', 'failed', 'skipped', 'awaiting_approval'
);
CREATE TYPE sw_risk_tier AS ENUM ('read', 'low', 'high');
CREATE TYPE sw_insight_status AS ENUM (
  'new', 'acknowledged', 'in_progress', 'resolved', 'dismissed', 'snoozed', 'expired'
);

-- §27.1 — every agent is a named, owned, permissioned, versioned entity.
CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  purpose         text NOT NULL,
  avatar          text,
  -- The accountable human. Required, cannot be a group (§27.1).
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  scope_department_id uuid REFERENCES departments(id),
  mode            sw_agent_mode NOT NULL DEFAULT 'assist',
  status          sw_agent_status NOT NULL DEFAULT 'draft',
  tool_grants     text[] NOT NULL DEFAULT '{}',
  data_scopes     text[] NOT NULL DEFAULT '{}',
  max_sensitivity sw_sensitivity NOT NULL DEFAULT 'internal',
  schedule_cron   text,
  budget          jsonb NOT NULL DEFAULT '{}'::jsonb,
  escalation_user_id uuid REFERENCES users(id),
  nudge_policy    jsonb NOT NULL DEFAULT '{"maxContactsPerPersonPerDay":3}'::jsonb,
  output_destinations jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_subagent     boolean NOT NULL DEFAULT false,
  published_by    uuid REFERENCES users(id),
  published_at    timestamptz,
  paused_reason   text,
  recertified_at  timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT agents_owner_required CHECK (owner_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX agents_org_key ON agents (organization_id, key) WHERE deleted_at IS NULL;

CREATE TABLE agent_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  snapshot        jsonb NOT NULL,
  justification   text,
  published_by    uuid REFERENCES users(id),
  second_approver_id uuid REFERENCES users(id),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX agent_versions_key ON agent_versions (agent_id, ordinal);

-- Org-level ceiling the agent can never exceed, configured per department (§4.4).
CREATE TABLE agent_permissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES departments(id),
  capability      text NOT NULL,          -- read | suggest | draft | execute:low | execute:high | restricted
  tool_pattern    text NOT NULL DEFAULT '*',
  effect          text NOT NULL DEFAULT 'allow',   -- allow | deny
  max_sensitivity sw_sensitivity NOT NULL DEFAULT 'internal',
  granted_by      uuid REFERENCES users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX agent_permissions_org_idx ON agent_permissions (organization_id, department_id) WHERE deleted_at IS NULL;

-- A run is a durable state machine, not an in-memory promise (§5.3).
CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  -- The human accountable for this run (§4.5). Never null.
  principal_user_id uuid NOT NULL REFERENCES users(id),
  mode            sw_agent_mode NOT NULL DEFAULT 'assist',
  status          sw_run_status NOT NULL DEFAULT 'queued',
  trigger         text NOT NULL DEFAULT 'user',   -- user | schedule | event | workflow | watcher
  request         text NOT NULL,
  ui_context      jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone        text NOT NULL DEFAULT 'UTC',
  plan            jsonb,
  report          jsonb,
  summary         text,
  failure_class   text,
  failure_detail  text,
  budget          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Live counters, checked before every step.
  steps_used      integer NOT NULL DEFAULT 0,
  tool_calls_used integer NOT NULL DEFAULT 0,
  tokens_in       integer NOT NULL DEFAULT 0,
  tokens_out      integer NOT NULL DEFAULT 0,
  cost_cents      numeric(12,4) NOT NULL DEFAULT 0,
  -- A run whose context contains untrusted external content is capability-downgraded (§5.9.3).
  contains_untrusted_content boolean NOT NULL DEFAULT false,
  capability_downgraded boolean NOT NULL DEFAULT false,
  injection_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_mode         sw_runtime_mode NOT NULL DEFAULT 'mock',
  trace_id        text NOT NULL,
  undone_at       timestamptz,
  undone_by       uuid REFERENCES users(id),
  started_at      timestamptz,
  finished_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX agent_runs_org_time_idx ON agent_runs (organization_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX agent_runs_org_status_idx ON agent_runs (organization_id, status, created_at DESC);
CREATE INDEX agent_runs_principal_idx ON agent_runs (organization_id, principal_user_id, created_at DESC);

CREATE TABLE agent_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  phase           text NOT NULL,          -- intake | ground | plan | gate | act | observe | reflect | report
  label           text NOT NULL,
  status          sw_step_status NOT NULL DEFAULT 'queued',
  subagent        text,
  tool_name       text,
  risk_tier       sw_risk_tier,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_class     text,
  error_message   text,
  duration_ms     integer,
  started_at      timestamptz,
  finished_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX agent_steps_key ON agent_steps (run_id, ordinal);
CREATE INDEX agent_steps_run_idx ON agent_steps (organization_id, run_id, ordinal);

CREATE TABLE agent_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  role            text NOT NULL,          -- user | assistant | system
  content         text NOT NULL,
  task_class      text,
  model           text,
  tokens_in       integer NOT NULL DEFAULT 0,
  tokens_out      integer NOT NULL DEFAULT 0,
  cost_cents      numeric(12,4) NOT NULL DEFAULT 0,
  latency_ms      integer,
  simulated       boolean NOT NULL DEFAULT false,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX agent_messages_run_idx ON agent_messages (organization_id, run_id, created_at);

CREATE TABLE tool_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id         uuid REFERENCES agent_steps(id) ON DELETE CASCADE,
  tool_name       text NOT NULL,
  risk_tier       sw_risk_tier NOT NULL DEFAULT 'read',
  -- Redacted per the tool's `redactions` declaration before storage.
  input           jsonb NOT NULL DEFAULT '{}'::jsonb,
  output          jsonb,
  ok              boolean,
  error_code      text,
  error_message   text,
  idempotency_key text NOT NULL,
  duration_ms     integer,
  args_hash       text NOT NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX tool_calls_idempotency_key ON tool_calls (organization_id, idempotency_key);
CREATE INDEX tool_calls_run_idx ON tool_calls (organization_id, run_id, created_at);

-- Provenance for every company-specific claim (§7.4).
CREATE TABLE citations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  claim           text NOT NULL,
  source_type     text NOT NULL,          -- document_chunk | task | message | company | query_aggregate
  source_id       uuid,
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  anchor          text,
  snippet         text,
  score           numeric(6,4),
  ordinal         integer NOT NULL DEFAULT 0,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX citations_run_idx ON citations (organization_id, run_id, ordinal);

-- §5.7 — every reversible write records its inverse so a whole run can be undone.
CREATE TABLE undo_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_call_id    uuid REFERENCES tool_calls(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  forward_tool    text NOT NULL,
  inverse_tool    text NOT NULL,
  inverse_input   jsonb NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  description     text NOT NULL,
  expires_at      timestamptz,
  undone_at       timestamptz,
  undone_by       uuid REFERENCES users(id),
  undo_error      text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX undo_operations_run_idx ON undo_operations (organization_id, run_id, ordinal);

-- §8.2 — memories are typed facts with source and confidence, not free-text blobs.
CREATE TABLE memory_facts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope           text NOT NULL,          -- organization | department | project | company | user
  scope_id        uuid,
  subject         text NOT NULL,
  predicate       text NOT NULL,
  object          text NOT NULL,
  confidence      numeric(4,3) NOT NULL DEFAULT 0.5,
  state           text NOT NULL DEFAULT 'candidate',  -- candidate | confirmed | superseded | forgotten
  volatile        boolean NOT NULL DEFAULT false,
  source_run_id   uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  source_citation jsonb,
  supersedes_id   uuid REFERENCES memory_facts(id),
  conflict_flagged boolean NOT NULL DEFAULT false,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  confirmed_by    uuid REFERENCES users(id),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX memory_facts_lookup_idx ON memory_facts (organization_id, scope, scope_id, state) WHERE deleted_at IS NULL;
CREATE INDEX memory_facts_subject_idx ON memory_facts (organization_id, subject, predicate) WHERE deleted_at IS NULL;

-- §9.2 — an insight with no evidence must not render; with no action it is noise.
CREATE TABLE insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  watcher         text NOT NULL,
  type            text NOT NULL,
  severity        text NOT NULL DEFAULT 'medium',
  title           text NOT NULL,
  body            text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  entities        jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence      numeric(4,3) NOT NULL DEFAULT 0.8,
  dedupe_key      text NOT NULL,
  status          sw_insight_status NOT NULL DEFAULT 'new',
  assigned_to     uuid REFERENCES users(id),
  snoozed_until   timestamptz,
  resolved_at     timestamptz,
  agent_run_id    uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT insights_need_evidence CHECK (jsonb_array_length(evidence) > 0),
  CONSTRAINT insights_need_action CHECK (jsonb_array_length(recommended_actions) > 0)
);
CREATE UNIQUE INDEX insights_dedupe_key ON insights (organization_id, dedupe_key) WHERE deleted_at IS NULL;
CREATE INDEX insights_org_status_idx ON insights (organization_id, status, severity, created_at DESC);

CREATE TABLE insight_feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  insight_id      uuid NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  helpful         boolean NOT NULL,
  reason          text,                   -- not_useful | wrong | already_handled | not_my_job
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX insight_feedback_idx ON insight_feedback (organization_id, insight_id);

-- §11.4 — the trust ledger justifies (and earns) expanded autonomy.
CREATE TABLE trust_ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES departments(id),
  action_type     text NOT NULL,
  outcome         text NOT NULL,          -- proposed | approved | edited | rejected | undone
  agent_run_id    uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  approval_id     uuid REFERENCES approvals(id) ON DELETE SET NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX trust_ledger_idx ON trust_ledger_entries (organization_id, action_type, outcome, occurred_at DESC);

-- Deferred foreign keys now that agent_runs exists.
ALTER TABLE tasks ADD CONSTRAINT tasks_agent_run_fk
  FOREIGN KEY (created_by_agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD CONSTRAINT approvals_agent_run_fk
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;
ALTER TABLE activities ADD CONSTRAINT activities_agent_run_fk
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_agent_run_fk
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE email_drafts ADD CONSTRAINT email_drafts_agent_run_fk
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_agent_run_fk
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;

SELECT sw_attach_touch(t) FROM (VALUES
  ('agents'::regclass), ('agent_versions'), ('agent_permissions'), ('agent_runs'), ('agent_steps'),
  ('agent_messages'), ('tool_calls'), ('citations'), ('undo_operations'), ('memory_facts'),
  ('insights'), ('insight_feedback'), ('trust_ledger_entries')
) AS x(t);
