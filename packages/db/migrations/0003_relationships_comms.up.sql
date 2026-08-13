-- 0003 · Relationships and communication.

CREATE TYPE sw_company_type AS ENUM ('customer', 'vendor', 'partner', 'prospect', 'other');
CREATE TYPE sw_message_direction AS ENUM ('inbound', 'outbound', 'internal');
CREATE TYPE sw_commitment_direction AS ENUM ('we_owe', 'they_owe');
CREATE TYPE sw_commitment_status AS ENUM (
  'proposed', 'confirmed', 'kept', 'renegotiated', 'slipped', 'cancelled', 'disputed'
);

CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  legal_name      text,
  type            sw_company_type NOT NULL DEFAULT 'customer',
  industry        text,
  domains         text[] NOT NULL DEFAULT '{}',
  owner_id        uuid REFERENCES users(id),
  health_status   text NOT NULL DEFAULT 'unknown',
  -- SLA in days for replying to this account's inbound threads. Drives the stale-thread watcher.
  reply_sla_days  integer NOT NULL DEFAULT 4,
  contract_renews_on date,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX companies_org_type_idx ON companies (organization_id, type, name) WHERE deleted_at IS NULL;
CREATE INDEX companies_name_trgm_idx ON companies USING gin (name gin_trgm_ops);
CREATE INDEX companies_domains_idx ON companies USING gin (domains);

ALTER TABLE projects ADD CONSTRAINT projects_company_fk
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  name            text NOT NULL,
  emails          text[] NOT NULL DEFAULT '{}',
  phones          text[] NOT NULL DEFAULT '{}',
  title           text,
  timezone        text,
  preferred_channel text,
  owner_id        uuid REFERENCES users(id),
  last_interaction_at timestamptz,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX contacts_org_company_idx ON contacts (organization_id, company_id) WHERE deleted_at IS NULL;
CREATE INDEX contacts_emails_idx ON contacts USING gin (emails);
CREATE INDEX contacts_name_trgm_idx ON contacts USING gin (name gin_trgm_ops);

CREATE TABLE notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  body            text NOT NULL,
  actor_type      sw_actor_type NOT NULL DEFAULT 'user',
  agent_run_id    uuid,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX notes_entity_idx ON notes (organization_id, entity_type, entity_id, created_at DESC);

-- Provider-agnostic conversation model; email is one channel among several.
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel         text NOT NULL DEFAULT 'email',
  external_id     text,
  subject         text NOT NULL,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  owner_id        uuid REFERENCES users(id),
  participants    jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_message_at timestamptz,
  last_direction  sw_message_direction,
  status          text NOT NULL DEFAULT 'open',
  classification  jsonb,
  snoozed_until   timestamptz,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX conversations_org_last_msg_idx ON conversations (organization_id, last_message_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX conversations_org_company_idx ON conversations (organization_id, company_id, last_message_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_id     text,
  direction       sw_message_direction NOT NULL,
  from_address    text NOT NULL,
  from_name       text,
  to_addresses    text[] NOT NULL DEFAULT '{}',
  cc_addresses    text[] NOT NULL DEFAULT '{}',
  sent_at         timestamptz NOT NULL DEFAULT now(),
  body_text       text NOT NULL DEFAULT '',
  -- Content that originated outside the organization is treated as adversarial (§5.9).
  trust_level     text NOT NULL DEFAULT 'untrusted_external',
  injection_flagged boolean NOT NULL DEFAULT false,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX messages_conversation_idx ON messages (organization_id, conversation_id, sent_at);

CREATE TABLE email_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  to_addresses    text[] NOT NULL DEFAULT '{}',
  cc_addresses    text[] NOT NULL DEFAULT '{}',
  subject         text NOT NULL,
  body_text       text NOT NULL,
  status          text NOT NULL DEFAULT 'draft',   -- draft | awaiting_approval | approved | sent | discarded
  agent_run_id    uuid,
  created_by_actor_type sw_actor_type NOT NULL DEFAULT 'user',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX email_drafts_org_status_idx ON email_drafts (organization_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE email_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  draft_id        uuid REFERENCES email_drafts(id) ON DELETE SET NULL,
  provider        text NOT NULL DEFAULT 'mock',
  provider_message_id text,
  -- Recall window (§5.7): dispatch only happens after send_after passes.
  send_after      timestamptz NOT NULL DEFAULT now(),
  recalled_at     timestamptz,
  sent_at         timestamptz,
  failed_at       timestamptz,
  error           text,
  idempotency_key text NOT NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX email_sends_idempotency_key ON email_sends (organization_id, idempotency_key);

-- §29.1 — an agent-detected promise is a suggestion until the named owner confirms it.
CREATE TABLE commitments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id   uuid REFERENCES users(id),
  counterparty_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  obligation      text NOT NULL,
  direction       sw_commitment_direction NOT NULL,
  due_at          timestamptz,
  status          sw_commitment_status NOT NULL DEFAULT 'proposed',
  confidence      numeric(4,3),
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  detected_by_agent_run_id uuid,
  confirmed_at    timestamptz,
  confirmed_by    uuid REFERENCES users(id),
  renegotiation_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_note      text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX commitments_org_due_idx ON commitments (organization_id, status, due_at) WHERE deleted_at IS NULL;

CREATE TABLE follow_ups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  owner_id        uuid REFERENCES users(id),
  due_at          timestamptz NOT NULL,
  reason          text,
  status          text NOT NULL DEFAULT 'open',
  agent_run_id    uuid,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX follow_ups_org_due_idx ON follow_ups (organization_id, status, due_at) WHERE deleted_at IS NULL;

SELECT sw_attach_touch(t) FROM (VALUES
  ('companies'::regclass), ('contacts'), ('notes'), ('conversations'), ('messages'),
  ('email_drafts'), ('email_sends'), ('commitments'), ('follow_ups')
) AS x(t);
