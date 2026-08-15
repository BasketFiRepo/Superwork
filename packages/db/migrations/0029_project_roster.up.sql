-- 0029 — Who is actually on a project.
--
-- `project_members` was created in migration 0002 and is written by exactly one thing: the
-- seed, which puts the owner on every project. Nothing reads it. So "being on a project" is
-- a row in a table and nothing else — it grants nothing, appears nowhere, and cannot be
-- changed, while the project page answers "who is doing this?" with one chip naming the
-- owner.
--
-- And who owns a project is stated twice. `projects.owner_id` is the column every read uses
-- — the list, the page, the `own` scope in the policy engine — and the roster carries a row
-- with role 'owner' beside it, written independently by the seed and reconciled by nobody.
-- Two statements of one fact is the shape that was wrong about the plan tier (ADR 0030) and
-- the jurisdiction profile (ADR 0028), and the answer is the same: one of them is the fact,
-- the database keeps the other true.

-- The four things somebody can be on a project. `role` was free text defaulting to
-- 'contributor', so 'Contributor', 'contrib' and 'lead ' were all different roles.
ALTER TABLE project_members
  ADD CONSTRAINT project_members_role_known
    CHECK (role IN ('owner', 'lead', 'contributor', 'reviewer'));

-- Why they are on it. Being on a project makes its work readable, and access wants a
-- reason — the same argument as `team_members.reason`, which has carried one since teams
-- were built.
ALTER TABLE project_members ADD COLUMN reason text;

-- One owner row per project, because `projects.owner_id` holds one owner. Without this the
-- derived row could be duplicated and "who owns this" would have two answers again.
CREATE UNIQUE INDEX project_members_one_owner
  ON project_members (project_id)
  WHERE deleted_at IS NULL AND role = 'owner';

-- The read this exists for: every project one person is on, for their own record, and every
-- person on one project, for the roster panel.
CREATE INDEX project_members_user_idx
  ON project_members (organization_id, user_id)
  WHERE deleted_at IS NULL;

/**
 * Both ends of a roster row belong to the same organization.
 *
 * RLS scopes the row itself; it says nothing about whether the project and the person named
 * inside it are the tenant's. A roster row pointing at another tenant's project would be a
 * read grant across the boundary, which is the one thing §3.2 exists to stop.
 */
CREATE OR REPLACE FUNCTION sw_project_member_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  project_ok boolean;
  member_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM projects
    WHERE id = NEW.project_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  ) INTO project_ok;

  SELECT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = NEW.user_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  ) INTO member_ok;

  IF NOT project_ok THEN
    RAISE EXCEPTION 'a roster row must name a project in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT member_ok THEN
    RAISE EXCEPTION 'a roster row must name a member of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER project_members_same_org
  BEFORE INSERT OR UPDATE ON project_members
  FOR EACH ROW EXECUTE FUNCTION sw_project_member_same_org();

/**
 * Keeps the roster's owner row in step with `projects.owner_id`.
 *
 * `owner_id` is the fact: it is what the list reads, what the page shows and what the `own`
 * scope in the policy engine resolves against. The roster row for the owner is derived from
 * it, so handing a project to somebody cannot leave the roster naming the person who used
 * to have it.
 *
 * The previous owner is demoted rather than removed. They were working on the project
 * before it changed hands and still are; taking somebody off a project is a decision
 * somebody makes, not a side effect of a hand-over.
 */
CREATE OR REPLACE FUNCTION sw_sync_project_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE project_members
  SET role = 'contributor', updated_at = now()
  WHERE project_id = NEW.id AND deleted_at IS NULL AND role = 'owner'
    AND user_id IS DISTINCT FROM NEW.owner_id;

  IF NEW.owner_id IS NOT NULL THEN
    INSERT INTO project_members (organization_id, project_id, user_id, role, reason, is_demo, created_by)
    VALUES (NEW.organization_id, NEW.id, NEW.owner_id, 'owner', 'Owns this project.', NEW.is_demo, NEW.created_by)
    ON CONFLICT (project_id, user_id) WHERE deleted_at IS NULL
    DO UPDATE SET role = 'owner', updated_at = now();
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER projects_sync_owner
  AFTER INSERT OR UPDATE OF owner_id ON projects
  FOR EACH ROW EXECUTE FUNCTION sw_sync_project_owner();

-- Bring what exists into step in the same migration, so the invariant holds from the moment
-- it is declared rather than from the next write.
UPDATE project_members m
SET role = 'contributor', updated_at = now()
FROM projects p
WHERE p.id = m.project_id AND m.deleted_at IS NULL AND m.role = 'owner'
  AND p.owner_id IS DISTINCT FROM m.user_id;

INSERT INTO project_members (organization_id, project_id, user_id, role, reason, is_demo, created_by)
SELECT p.organization_id, p.id, p.owner_id, 'owner', 'Owns this project.', p.is_demo, p.created_by
FROM projects p
WHERE p.deleted_at IS NULL AND p.owner_id IS NOT NULL
ON CONFLICT (project_id, user_id) WHERE deleted_at IS NULL
DO UPDATE SET role = 'owner', updated_at = now();
