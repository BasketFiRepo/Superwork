-- 0022 — Teams, and the axis they were supposed to provide.
--
-- `teams` and `team_members` were created in migration 0001 and nothing has ever written to
-- either. The consequence is larger than two empty tables, because the team *scope* is dead
-- in three independent ways:
--
--   1. no team exists;
--   2. no resource table carries a team_id, so nothing is team-scoped;
--   3. nothing ever passes `resource.teamIds` to `can()`, so `scopeSatisfied('team', …)`
--      evaluates `[].some(…)` and returns false even when the first two are fixed.
--
-- And the role that pays for it is `guest`, whose permissions are `task:read:team`,
-- `project:read:team`, `document:read:team`, `note:create:team` and two agent-run grants.
-- Every one of the five is team-scoped, so a guest can read nothing at all — the role has
-- been non-functional since Phase 0 and denies with "You need Member access", which reads
-- like a deliberate policy rather than a missing dimension.
--
-- The team_id columns are nullable everywhere. Most work belongs to a department and a
-- person, and forcing a team onto it would be inventing structure to satisfy a schema.

ALTER TABLE tasks ADD COLUMN team_id uuid REFERENCES teams(id);
ALTER TABLE projects ADD COLUMN team_id uuid REFERENCES teams(id);
ALTER TABLE documents ADD COLUMN team_id uuid REFERENCES teams(id);

-- The scope check asks "is this row's team one of mine", so the team is the leading column.
CREATE INDEX tasks_team_idx ON tasks (organization_id, team_id)
  WHERE deleted_at IS NULL AND team_id IS NOT NULL;
CREATE INDEX projects_team_idx ON projects (organization_id, team_id)
  WHERE deleted_at IS NULL AND team_id IS NOT NULL;
CREATE INDEX documents_team_idx ON documents (organization_id, team_id)
  WHERE deleted_at IS NULL AND team_id IS NOT NULL;

-- Two teams with the same name in one organization is an invitation to share the wrong
-- document with the wrong people.
CREATE UNIQUE INDEX teams_name_once ON teams (organization_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;

ALTER TABLE teams ADD CONSTRAINT teams_name_given CHECK (length(btrim(name)) >= 2);

-- A team has leads and members. The column existed with a default and no constraint, so
-- 'membr' was as valid as 'member'.
ALTER TABLE team_members ADD CONSTRAINT team_members_role_known
  CHECK (role IN ('lead', 'member'));

-- `loadActor` reads this on every request, by user.
CREATE INDEX team_members_user_idx ON team_members (organization_id, user_id)
  WHERE deleted_at IS NULL;

-- Why somebody is on a team, kept for the same reason a circulation list keeps it: a
-- membership nobody can explain is one nobody will ever remove.
ALTER TABLE team_members ADD COLUMN reason text;
ALTER TABLE teams ADD COLUMN purpose text;
