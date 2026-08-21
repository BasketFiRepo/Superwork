-- Undoes 0057. The `team_id` columns and their indexes belong to 0022 and stay; what goes is
-- the guarantee that a value in one of them names a live team in the same organization.

DROP TRIGGER IF EXISTS documents_team_same_org_update ON documents;
DROP TRIGGER IF EXISTS documents_team_same_org_insert ON documents;
DROP TRIGGER IF EXISTS projects_team_same_org_update ON projects;
DROP TRIGGER IF EXISTS projects_team_same_org_insert ON projects;
DROP TRIGGER IF EXISTS tasks_team_same_org_update ON tasks;
DROP TRIGGER IF EXISTS tasks_team_same_org_insert ON tasks;

DROP FUNCTION IF EXISTS sw_team_scope_same_org();
