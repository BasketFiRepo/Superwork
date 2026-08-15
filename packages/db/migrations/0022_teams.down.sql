-- 0022 · rollback

ALTER TABLE teams DROP COLUMN IF EXISTS purpose;
ALTER TABLE team_members DROP COLUMN IF EXISTS reason;

DROP INDEX IF EXISTS team_members_user_idx;
ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_role_known;

ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_name_given;
DROP INDEX IF EXISTS teams_name_once;

DROP INDEX IF EXISTS documents_team_idx;
DROP INDEX IF EXISTS projects_team_idx;
DROP INDEX IF EXISTS tasks_team_idx;

ALTER TABLE documents DROP COLUMN IF EXISTS team_id;
ALTER TABLE projects DROP COLUMN IF EXISTS team_id;
ALTER TABLE tasks DROP COLUMN IF EXISTS team_id;
