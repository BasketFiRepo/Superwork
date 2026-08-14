-- 0012 · Phase 4 — enterprise scale
--
-- Three claims have to hold (§24, Phase 4):
--   1. a 100,000-user tenant meets the §26.9 budgets under load;
--   2. no department can starve another's agent runs;
--   3. the accountability features pass a works-council-style review in the strictest
--      configured jurisdiction.
--
-- The second needs a queue that schedules fairly rather than first-come-first-served.
-- The third needs the jurisdiction to be a row with teeth, and the consultation that
-- legitimises §29 to be a record rather than an assurance. The first is mostly indexes
-- and query shape, plus a load harness that measures rather than assumes.

-- ---------------------------------------------------------------------------
-- Fair scheduling (§26.6)
-- ---------------------------------------------------------------------------

-- A run's department is resolved once, at enqueue time. Resolving it later means a
-- membership change silently re-classes work that is already in the queue.
ALTER TABLE agent_runs
  ADD COLUMN department_id uuid REFERENCES departments(id),
  ADD COLUMN queue_class text NOT NULL DEFAULT 'interactive',
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claimed_by text,
  ADD COLUMN queue_wait_ms integer,
  ADD CONSTRAINT queue_class_known CHECK (queue_class IN ('interactive', 'background', 'bulk'));

CREATE INDEX agent_runs_queue_idx
  ON agent_runs (organization_id, status, queue_class, queued_at)
  WHERE deleted_at IS NULL AND status = 'queued';

CREATE INDEX agent_runs_department_idx
  ON agent_runs (organization_id, department_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE department_quotas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL is the default row every department inherits until one is set for it.
  department_id   uuid REFERENCES departments(id) ON DELETE CASCADE,
  -- Share of the scheduler's attention. Two departments on 1 and 3 get 1:3 of the slots
  -- when both have work, and all of it when the other is idle (§26.6).
  weight          integer NOT NULL DEFAULT 1,
  max_concurrent  integer NOT NULL DEFAULT 4,
  runs_per_hour   integer NOT NULL DEFAULT 240,
  -- Deficit round-robin state, updated by the scheduler in the same transaction that
  -- claims a run, so two schedulers cannot both believe they are owed a turn.
  deficit         integer NOT NULL DEFAULT 0,
  last_served_at  timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT quota_positive CHECK (weight > 0 AND max_concurrent > 0 AND runs_per_hour > 0)
);
CREATE UNIQUE INDEX department_quotas_key
  ON department_quotas (organization_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Relation tuples (§4.6)
-- ---------------------------------------------------------------------------

-- Roles say what a kind of person may do; tuples say what *this* person may do with
-- *this* thing. Sharing a project with a colleague is a tuple, not a role change.
CREATE TABLE relation_tuples (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_type    text NOT NULL,          -- user | team | department
  subject_id      uuid NOT NULL,
  relation        text NOT NULL,          -- viewer | editor | owner | approver
  object_type     text NOT NULL,          -- project | document | knowledge_space | company
  object_id       uuid NOT NULL,
  -- Why it exists, so a review can tell a deliberate grant from an accident.
  granted_by      uuid REFERENCES users(id),
  reason          text,
  expires_at      timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT relation_known CHECK (relation IN ('viewer', 'editor', 'owner', 'approver')),
  CONSTRAINT subject_known CHECK (subject_type IN ('user', 'team', 'department'))
);
CREATE UNIQUE INDEX relation_tuples_unique
  ON relation_tuples (organization_id, subject_type, subject_id, relation, object_type, object_id)
  WHERE deleted_at IS NULL;
-- The check is a point lookup on this index: subject → objects, and object → subjects.
CREATE INDEX relation_tuples_subject_idx
  ON relation_tuples (organization_id, subject_type, subject_id, object_type)
  WHERE deleted_at IS NULL;
CREATE INDEX relation_tuples_object_idx
  ON relation_tuples (organization_id, object_type, object_id)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Legal entities and jurisdiction profiles (§26.1, §29.6)
-- ---------------------------------------------------------------------------

CREATE TABLE legal_entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  country         text NOT NULL,
  -- The profile decides what §29 may do here. It defaults to the most restrictive.
  jurisdiction_profile text NOT NULL DEFAULT 'works_council',
  data_region     text NOT NULL DEFAULT 'eu',
  -- Works council consultation: without it, §29 features stay off in this entity.
  consultation_status text NOT NULL DEFAULT 'not_started',
  consultation_reference text,
  consultation_recorded_by uuid REFERENCES users(id),
  consultation_recorded_at timestamptz,
  consultation_expires_at timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT jurisdiction_known CHECK (
    jurisdiction_profile IN ('works_council', 'gdpr', 'standard')
  ),
  CONSTRAINT consultation_status_known CHECK (
    consultation_status IN ('not_started', 'in_progress', 'agreed', 'refused', 'expired')
  ),
  -- An agreed consultation without a reference is an assurance, not a record.
  CONSTRAINT consultation_agreed_has_reference CHECK (
    consultation_status <> 'agreed'
    OR (consultation_reference IS NOT NULL AND consultation_recorded_by IS NOT NULL)
  )
);
CREATE UNIQUE INDEX legal_entities_name ON legal_entities (organization_id, name) WHERE deleted_at IS NULL;

ALTER TABLE departments
  ADD COLUMN legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE SET NULL;

-- Loosening a profile is a decision somebody signs for.
CREATE TABLE jurisdiction_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
  from_profile    text NOT NULL,
  to_profile      text NOT NULL,
  justification   text NOT NULL,
  approved_by     uuid REFERENCES users(id),
  changed_by      uuid NOT NULL REFERENCES users(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- The nudge ladder and its shared budget (§29.2)
-- ---------------------------------------------------------------------------

CREATE TABLE nudges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The person being contacted. The budget is theirs, shared across every agent.
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What it is about, so completing the work cancels the ladder everywhere at once.
  subject_type    text NOT NULL,          -- task | commitment | approval
  subject_id      uuid NOT NULL,
  stage           integer NOT NULL DEFAULT 1,
  channel         text NOT NULL DEFAULT 'in_app',
  message         text NOT NULL,
  -- One action closes it: done | snooze | renegotiate | reassign | blocked.
  actions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for   timestamptz NOT NULL,
  delivered_at    timestamptz,
  responded_at    timestamptz,
  response        text,
  cancelled_at    timestamptz,
  cancel_reason   text,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT nudge_stage_range CHECK (stage BETWEEN 1 AND 5)
);
CREATE INDEX nudges_due_idx ON nudges (organization_id, scheduled_for)
  WHERE deleted_at IS NULL AND delivered_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX nudges_recipient_day_idx ON nudges (organization_id, recipient_user_id, delivered_at DESC)
  WHERE deleted_at IS NULL;
-- One live ladder per person per thing: two agents chasing the same task is the
-- behaviour that makes people mute the product.
CREATE UNIQUE INDEX nudges_one_open_per_subject
  ON nudges (organization_id, recipient_user_id, subject_type, subject_id)
  WHERE deleted_at IS NULL AND cancelled_at IS NULL AND responded_at IS NULL;

-- ---------------------------------------------------------------------------
-- Placement: shards and dedicated tiers (§26.10)
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_placements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shard           text NOT NULL DEFAULT 'primary',
  tier            text NOT NULL DEFAULT 'shared',   -- shared | dedicated
  region          text NOT NULL DEFAULT 'eu',
  -- Set when a tenant is being moved; reads follow the source until the cutover.
  migrating_to    text,
  migration_started_at timestamptz,
  notes           text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT tier_known CHECK (tier IN ('shared', 'dedicated'))
);
CREATE UNIQUE INDEX tenant_placements_org ON tenant_placements (organization_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Indexes the §26.9 budgets depend on
-- ---------------------------------------------------------------------------

-- The list view is scoped by assignee and status and ordered by the keyset; at 50M rows
-- the ordering columns have to be in the index or the sort dominates.
CREATE INDEX tasks_assignee_keyset_idx
  ON tasks (organization_id, assignee_id, status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX memberships_lookup_idx
  ON memberships (user_id, organization_id)
  WHERE deleted_at IS NULL;

CREATE INDEX notifications_fanout_idx
  ON notifications (organization_id, deliver_after)
  WHERE deleted_at IS NULL AND delivered_at IS NULL;

SELECT sw_attach_touch(t) FROM (VALUES
  ('department_quotas'::regclass), ('relation_tuples'), ('legal_entities'),
  ('jurisdiction_changes'), ('nudges'), ('tenant_placements')
) AS x(t);

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'department_quotas', 'relation_tuples', 'legal_entities', 'jurisdiction_changes',
    'nudges', 'tenant_placements'
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
