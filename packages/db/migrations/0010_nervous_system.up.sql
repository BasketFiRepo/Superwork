-- 0010 · The company nervous system: inbox triage, meetings, CRM depth, briefings.

-- ---------------------------------------------------------------------------
-- Inbox triage state (§12.3)
-- ---------------------------------------------------------------------------

CREATE TYPE sw_conversation_category AS ENUM (
  'needs_reply', 'needs_action', 'waiting_on_others', 'fyi', 'urgent', 'spam'
);

ALTER TABLE conversations
  ADD COLUMN category        sw_conversation_category,
  ADD COLUMN priority        sw_priority,
  ADD COLUMN sentiment       text,
  ADD COLUMN triaged_at      timestamptz,
  ADD COLUMN triaged_by_agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  ADD COLUMN archived_at     timestamptz,
  -- "Waiting for" tracking: what we asked for, and when we should nudge if it never lands.
  ADD COLUMN waiting_for     text,
  ADD COLUMN waiting_since   timestamptz,
  ADD COLUMN assigned_to     uuid REFERENCES users(id);

CREATE INDEX conversations_triage_idx
  ON conversations (organization_id, category, priority, last_message_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX conversations_queue_idx
  ON conversations (organization_id, archived_at, snoozed_until, last_message_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE messages
  -- Remote images are tracking pixels until proven otherwise; the renderer strips them
  -- and tells the reader it did (§5.9.7).
  ADD COLUMN remote_image_count integer NOT NULL DEFAULT 0,
  ADD COLUMN link_count         integer NOT NULL DEFAULT 0,
  ADD COLUMN sanitized_at       timestamptz;

-- Which mailbox a conversation came from, and the health of that connection.
CREATE TABLE email_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  address         text NOT NULL,
  provider        text NOT NULL DEFAULT 'mock',
  status          text NOT NULL DEFAULT 'connected',   -- connected | expired | revoked | error
  scopes          text[] NOT NULL DEFAULT '{}',
  sync_cursor     text,
  last_sync_at    timestamptz,
  last_error      text,
  token_expires_at timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX email_accounts_address_key ON email_accounts (organization_id, lower(address))
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Meetings and transcripts (§12.5)
-- ---------------------------------------------------------------------------

CREATE TYPE sw_meeting_status AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');

CREATE TABLE meetings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  agenda          jsonb NOT NULL DEFAULT '[]'::jsonb,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  organizer_id    uuid REFERENCES users(id),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  timezone        text NOT NULL DEFAULT 'UTC',
  location        text,
  status          sw_meeting_status NOT NULL DEFAULT 'scheduled',
  -- A recurring series carries rolling context across occurrences.
  series_id       uuid,
  series_ordinal  integer,
  -- Recording and transcription need per-meeting acknowledgement, and some
  -- jurisdictions require every party to consent (§12.5).
  recording_consent_required boolean NOT NULL DEFAULT true,
  recording_consent_mode text NOT NULL DEFAULT 'all_parties',  -- all_parties | one_party
  recording_consent_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_event_id text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT meetings_time_order CHECK (ends_at > starts_at)
);
CREATE INDEX meetings_org_time_idx ON meetings (organization_id, starts_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX meetings_series_idx ON meetings (organization_id, series_id, series_ordinal) WHERE series_id IS NOT NULL;

CREATE TABLE meeting_participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE CASCADE,
  display_name    text NOT NULL,
  role            text NOT NULL DEFAULT 'attendee',
  attended        boolean,
  consented_at    timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT meeting_participants_identity CHECK (user_id IS NOT NULL OR contact_id IS NOT NULL OR display_name <> '')
);
CREATE INDEX meeting_participants_idx ON meeting_participants (organization_id, meeting_id);

CREATE TABLE transcripts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  source          text NOT NULL DEFAULT 'upload',
  language        text NOT NULL DEFAULT 'en',
  duration_seconds integer,
  -- Transcripts are ingested into company memory as a document so they are retrievable
  -- and citable alongside everything else.
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  processed_at    timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX transcripts_meeting_key ON transcripts (meeting_id) WHERE deleted_at IS NULL;

CREATE TABLE transcript_segments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transcript_id   uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  speaker         text NOT NULL,
  speaker_user_id uuid REFERENCES users(id),
  -- Segment timestamps are the citation anchors for anything derived from a meeting.
  starts_at_seconds integer NOT NULL,
  ends_at_seconds integer,
  text            text NOT NULL,
  -- Participant speech is external content until we know who said it and why.
  trust_level     text NOT NULL DEFAULT 'org_data',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX transcript_segments_key ON transcript_segments (transcript_id, ordinal);
CREATE INDEX transcript_segments_time_idx ON transcript_segments (organization_id, transcript_id, starts_at_seconds);

-- The decision log: the most valuable and most neglected artifact in project work (§12.2).
CREATE TABLE decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  meeting_id      uuid REFERENCES meetings(id) ON DELETE SET NULL,
  summary         text NOT NULL,
  rationale       text,
  rejected_alternatives text[] NOT NULL DEFAULT '{}',
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz NOT NULL DEFAULT now(),
  -- Deferring is itself a decision worth recording; a recurring series can then show
  -- "this was deferred three times".
  status          text NOT NULL DEFAULT 'decided',   -- decided | deferred | reversed
  source_segment_id uuid REFERENCES transcript_segments(id) ON DELETE SET NULL,
  confidence      numeric(4,3),
  confirmed_at    timestamptz,
  confirmed_by    uuid REFERENCES users(id),
  agent_run_id    uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX decisions_org_idx ON decisions (organization_id, decided_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX decisions_project_idx ON decisions (organization_id, project_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- CRM depth (§12.6)
-- ---------------------------------------------------------------------------

ALTER TABLE contacts
  ADD COLUMN seniority   text,
  ADD COLUMN merged_into_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN next_step_at timestamptz,
  ADD COLUMN next_step   text;

ALTER TABLE companies
  ADD COLUMN size_band   text,
  ADD COLUMN last_interaction_at timestamptz,
  ADD COLUMN check_in_days integer NOT NULL DEFAULT 30;

-- New contacts are proposed, never silently created (§12.6).
CREATE TABLE contact_merge_candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  primary_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  duplicate_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  similarity      numeric(4,3) NOT NULL,
  reasons         text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending',   -- pending | merged | rejected
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id),
  field_resolution jsonb,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT merge_candidates_distinct CHECK (primary_contact_id <> duplicate_contact_id)
);
CREATE UNIQUE INDEX contact_merge_candidates_key
  ON contact_merge_candidates (organization_id, primary_contact_id, duplicate_contact_id)
  WHERE deleted_at IS NULL;

-- Every touch on an account, whatever the channel.
CREATE TABLE interactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id),
  kind            text NOT NULL,          -- email | call | meeting | note | task
  direction       sw_message_direction,
  summary         text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  source_type     text,
  source_id       uuid,
  agent_run_id    uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX interactions_company_idx ON interactions (organization_id, company_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Briefings and notification preferences (§9.4, §15.1)
-- ---------------------------------------------------------------------------

CREATE TYPE sw_briefing_kind AS ENUM ('daily', 'end_of_day');

CREATE TABLE briefings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            sw_briefing_kind NOT NULL DEFAULT 'daily',
  -- The local date the briefing covers, in the recipient's timezone.
  local_date      date NOT NULL,
  timezone        text NOT NULL,
  -- Every figure is computed in SQL and stored, so the briefing is reproducible and
  -- auditable. The model writes `narrative` only, from these numbers (§9.4).
  facts           jsonb NOT NULL,
  narrative       text NOT NULL,
  recommendation  jsonb,
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  agent_run_id    uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,
  cost_cents      numeric(12,4) NOT NULL DEFAULT 0,
  simulated       boolean NOT NULL DEFAULT false,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX briefings_key ON briefings (organization_id, user_id, kind, local_date)
  WHERE deleted_at IS NULL;
CREATE INDEX briefings_user_idx ON briefings (organization_id, user_id, local_date DESC);

CREATE TABLE notification_preferences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Digest is the default for anything non-blocking (§15.1).
  channel_defaults jsonb NOT NULL DEFAULT '{"in_app":"immediate","email":"digest"}'::jsonb,
  per_type        jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiet_hours     jsonb NOT NULL DEFAULT '{"start":"18:30","end":"08:30"}'::jsonb,
  briefing_hour   integer NOT NULL DEFAULT 8,
  end_of_day_hour integer NOT NULL DEFAULT 17,
  briefing_enabled boolean NOT NULL DEFAULT true,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT briefing_hour_valid CHECK (briefing_hour BETWEEN 0 AND 23),
  CONSTRAINT end_of_day_hour_valid CHECK (end_of_day_hour BETWEEN 0 AND 23)
);
CREATE UNIQUE INDEX notification_preferences_key ON notification_preferences (organization_id, user_id)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Commitments: the owner confirms before it counts (§29.1)
-- ---------------------------------------------------------------------------

ALTER TABLE commitments
  ADD COLUMN source_segment_id uuid REFERENCES transcript_segments(id) ON DELETE SET NULL,
  ADD COLUMN source_excerpt    text,
  ADD COLUMN disputed_reason   text,
  ADD COLUMN task_id           uuid REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX commitments_owner_idx ON commitments (organization_id, owner_user_id, status, due_at)
  WHERE deleted_at IS NULL;

SELECT sw_attach_touch(t) FROM (VALUES
  ('email_accounts'::regclass), ('meetings'), ('meeting_participants'), ('transcripts'),
  ('transcript_segments'), ('decisions'), ('contact_merge_candidates'), ('interactions'),
  ('briefings'), ('notification_preferences')
) AS x(t);

-- New tenant tables need the same isolation guarantees as every other table.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'email_accounts', 'meetings', 'meeting_participants', 'transcripts', 'transcript_segments',
    'decisions', 'contact_merge_candidates', 'interactions', 'briefings', 'notification_preferences'
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
