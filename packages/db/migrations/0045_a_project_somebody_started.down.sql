DROP INDEX IF EXISTS projects_one_open_name;

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_dates_in_order;
