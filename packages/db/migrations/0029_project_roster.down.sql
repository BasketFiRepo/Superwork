DROP TRIGGER IF EXISTS projects_sync_owner ON projects;
DROP FUNCTION IF EXISTS sw_sync_project_owner();
DROP TRIGGER IF EXISTS project_members_same_org ON project_members;
DROP FUNCTION IF EXISTS sw_project_member_same_org();
DROP INDEX IF EXISTS project_members_user_idx;
DROP INDEX IF EXISTS project_members_one_owner;
ALTER TABLE project_members DROP COLUMN IF EXISTS reason;
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_known;
