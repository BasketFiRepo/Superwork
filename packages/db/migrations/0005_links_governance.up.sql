-- 0005 · Connective tissue and governance: links, activity, audit, approvals, outbox.

CREATE TYPE sw_link_relation AS ENUM (
  'mentions', 'derived_from', 'blocks', 'relates_to', 'attached_to', 'resolves', 'supersedes'
);
CREATE TYPE sw_approval_status AS ENUM (
  'pending', 'approved', 'approved_with_edits', 'rejected', 'delegated', 'expired', 'cancelled'
);

-- §3.4 — the single highest-leverage schema decision: one polymorphic edge table.
-- Every agent-created entity carries a `derived_from` link back to its source.
CREATE TABLE links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_type       text NOT NULL,
  from_id         uuid NOT NULL,
  to_type         text NOT NULL,
  to_id           uuid NOT NULL,
  relation        sw_link_relation NOT NULL DEFAULT 'relates_to',
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX links_key ON links (organization_id, from_type, from_id, to_type, to_id, relation)
  WHERE deleted_at IS NULL;
CREATE INDEX links_from_idx ON links (organization_id, from_type, from_id) WHERE deleted_at IS NULL;
CREATE INDEX links_to_idx ON links (organization_id, to_type, to_id) WHERE deleted_at IS NULL;

-- Human-facing timeline. Denormalized on purpose. Distinct from audit_logs (§3.6).
CREATE TABLE activities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type      sw_actor_type NOT NULL,
  actor_user_id   uuid REFERENCES users(id),
  actor_agent_id  uuid,
  actor_label     text NOT NULL,
  verb            text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  entity_label    text NOT NULL,
  summary         text NOT NULL,
  agent_run_id    uuid,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX activities_org_time_idx ON activities (organization_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX activities_entity_idx ON activities (organization_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX activities_actor_type_idx ON activities (organization_id, actor_type, occurred_at DESC);

-- Forensic record. Append-only: UPDATE/DELETE are revoked from the app role in 0008
-- and blocked by trigger for every role.
CREATE TABLE audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type      sw_actor_type NOT NULL,
  actor_id        uuid,
  principal_user_id uuid REFERENCES users(id),
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  diff            jsonb,
  redacted_fields text[] NOT NULL DEFAULT '{}',
  ip              inet,
  user_agent      text,
  request_id      text,
  trace_id        text,
  agent_run_id    uuid,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (organization_id, occurred_at DESC);
CREATE INDEX audit_logs_run_idx ON audit_logs (agent_run_id) WHERE agent_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION sw_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION sw_audit_append_only();

CREATE TABLE approval_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  -- Declarative rule: { match: {...}, require: { approverRole, slaHours }, effect: 'require'|'deny' }
  rule            jsonb NOT NULL,
  priority        integer NOT NULL DEFAULT 100,
  enabled         boolean NOT NULL DEFAULT true,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX approval_policies_org_idx ON approval_policies (organization_id, priority) WHERE deleted_at IS NULL;

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  kind            text NOT NULL DEFAULT 'agent_plan',   -- agent_plan | tool_call | workflow_activation
  status          sw_approval_status NOT NULL DEFAULT 'pending',
  risk_tier       text NOT NULL DEFAULT 'low',
  requested_by_actor_type sw_actor_type NOT NULL DEFAULT 'agent',
  requested_by_user_id uuid REFERENCES users(id),
  agent_run_id    uuid,
  approver_user_id uuid REFERENCES users(id),
  approver_role   sw_role,
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_reason text,
  delegated_to    uuid REFERENCES users(id),
  policy_id       uuid REFERENCES approval_policies(id),
  policy_reason   text,
  sla_hours       integer NOT NULL DEFAULT 4,
  expires_at      timestamptz,
  -- Rendered preview() diffs, evidence and citations — what makes an approval meaningful (§11.2).
  preview         jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  edits           jsonb,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX approvals_org_status_idx ON approvals (organization_id, status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX approvals_approver_idx ON approvals (organization_id, approver_user_id, status);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL,
  title           text NOT NULL,
  body            text,
  entity_type     text,
  entity_id       uuid,
  url             text,
  channel         text NOT NULL DEFAULT 'in_app',
  delivery        text NOT NULL DEFAULT 'digest',      -- immediate | digest | none
  read_at         timestamptz,
  deliver_after   timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX notifications_user_idx ON notifications (organization_id, user_id, read_at, created_at DESC);

-- Internal event bus log. Workflow triggers and watchers read from here.
CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  entity_type     text,
  entity_id       uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type      sw_actor_type NOT NULL DEFAULT 'system',
  actor_id        uuid,
  trace_id        text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX events_org_name_time_idx ON events (organization_id, name, occurred_at DESC);

-- Transactional outbox (§2.4): intent is written in the same transaction as the state
-- change; dispatch happens asynchronously and idempotently.
CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',     -- pending | dispatching | dispatched | failed | dead
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  dispatched_at   timestamptz,
  trace_id        text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX outbox_idempotency_key ON outbox (organization_id, topic, idempotency_key);
CREATE INDEX outbox_queue_idx ON outbox (status, next_attempt_at) WHERE status IN ('pending', 'failed');

SELECT sw_attach_touch(t) FROM (VALUES
  ('links'::regclass), ('activities'), ('approval_policies'), ('approvals'),
  ('notifications'), ('events'), ('outbox')
) AS x(t);
