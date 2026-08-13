-- 0002 · Work: projects, milestones, tasks.

CREATE TYPE sw_task_status AS ENUM (
  'backlog', 'todo', 'in_progress', 'waiting', 'blocked', 'review', 'completed', 'cancelled'
);
CREATE TYPE sw_priority AS ENUM ('urgent', 'high', 'medium', 'low');
CREATE TYPE sw_project_status AS ENUM ('planning', 'active', 'on_hold', 'completed', 'cancelled');

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES departments(id),
  company_id      uuid,                         -- FK added in 0003 once companies exists
  name            text NOT NULL,
  key             text,
  description     text,
  status          sw_project_status NOT NULL DEFAULT 'planning',
  owner_id        uuid REFERENCES users(id),
  starts_on       date,
  target_date     date,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  -- Health is computed deterministically in SQL/domain code; the model only explains it (§12.2).
  health_score    integer,
  health_computed_at timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX projects_org_status_idx ON projects (organization_id, status, target_date)
  WHERE deleted_at IS NULL;

CREATE TABLE project_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'contributor',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX project_members_key ON project_members (project_id, user_id) WHERE deleted_at IS NULL;

CREATE TABLE milestones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            text NOT NULL,
  due_on          date,
  status          text NOT NULL DEFAULT 'open',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  milestone_id    uuid REFERENCES milestones(id) ON DELETE SET NULL,
  parent_task_id  uuid REFERENCES tasks(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES departments(id),
  title           text NOT NULL,
  description     text,
  status          sw_task_status NOT NULL DEFAULT 'todo',
  priority        sw_priority NOT NULL DEFAULT 'medium',
  assignee_id     uuid REFERENCES users(id),
  -- `waiting` names who/what; `blocked` requires a reason (§12.1).
  waiting_on      text,
  blocked_reason  text,
  starts_on       date,
  due_at          timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  estimate_minutes integer,
  actual_minutes  integer,
  recurrence_rule text,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  -- Provenance for anything the agent created (§3.4, §5.1).
  created_by_actor_type sw_actor_type NOT NULL DEFAULT 'user',
  created_by_agent_run_id uuid,
  ai_confidence   numeric(4,3),
  custom_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT tasks_waiting_needs_target CHECK (status <> 'waiting' OR waiting_on IS NOT NULL),
  CONSTRAINT tasks_blocked_needs_reason CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL)
);
-- Composite indexes for the list views, not a bare organization_id index (§3.5).
CREATE INDEX tasks_org_assignee_due_idx ON tasks (organization_id, assignee_id, due_at)
  WHERE deleted_at IS NULL AND status NOT IN ('completed', 'cancelled');
CREATE INDEX tasks_org_status_due_idx ON tasks (organization_id, status, due_at)
  WHERE deleted_at IS NULL;
CREATE INDEX tasks_org_project_idx ON tasks (organization_id, project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_title_trgm_idx ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX tasks_run_idx ON tasks (created_by_agent_run_id) WHERE created_by_agent_run_id IS NOT NULL;

CREATE TABLE task_dependencies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT task_dependencies_no_self CHECK (task_id <> depends_on_task_id)
);
CREATE UNIQUE INDEX task_dependencies_key ON task_dependencies (task_id, depends_on_task_id) WHERE deleted_at IS NULL;

CREATE TABLE task_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body            text NOT NULL,
  actor_type      sw_actor_type NOT NULL DEFAULT 'user',
  agent_id        uuid,
  mentions        uuid[] NOT NULL DEFAULT '{}',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX task_comments_task_idx ON task_comments (organization_id, task_id, created_at);

CREATE TABLE task_watchers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX task_watchers_key ON task_watchers (task_id, user_id) WHERE deleted_at IS NULL;

CREATE TABLE saved_views (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  entity          text NOT NULL,
  query           jsonb NOT NULL DEFAULT '{}'::jsonb,
  shared          boolean NOT NULL DEFAULT false,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);

SELECT sw_attach_touch(t) FROM (VALUES
  ('projects'::regclass), ('project_members'), ('milestones'), ('tasks'), ('task_dependencies'),
  ('task_comments'), ('task_watchers'), ('saved_views')
) AS x(t);
