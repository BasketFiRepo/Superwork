-- 0044 — The work a milestone is made of.
--
-- `tasks.milestone_id` has existed since migration 0002 and nothing has ever written it.
--
-- Milestones themselves became real in ADR 0036: a project can add one, reschedule it, reach
-- it or drop it, and the health score reads their dates. But a milestone was a date with a
-- name on it and nothing underneath — "are we going to make it" had no answer beyond somebody
-- looking at the calendar, and "what is this milestone actually waiting on" had none at all.
-- The column that would answer both was carried through the recurring-task copy (ADR 0041)
-- and set by nobody, so every occurrence of a repeating task copied a null.
--
-- Two rules are enforced here rather than in the one code path that writes the column today:
--
--   1. a task's milestone belongs to the task's own project — a milestone is a promise a
--      *project* makes, so work filed against one from a different project is a statement no
--      screen could ever render honestly;
--   2. a task cannot be on a milestone while belonging to no project at all.

ALTER TABLE tasks
  ADD CONSTRAINT tasks_milestone_needs_project
    CHECK (milestone_id IS NULL OR project_id IS NOT NULL);

/**
 * The milestone is the project's own.
 *
 * A trigger rather than a composite foreign key: the natural key would be
 * `(project_id, milestone_id) REFERENCES milestones (project_id, id)`, and its
 * `ON DELETE SET NULL` would null *both* columns — so hard-deleting a milestone would quietly
 * unfile every one of its tasks from the project too. The existing single-column reference
 * already does the right thing on its own (the task loses its milestone and keeps its
 * project); this adds the cross-row rule that reference cannot express.
 */
CREATE OR REPLACE FUNCTION sw_task_milestone_belongs_to_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_project uuid;
BEGIN
  IF NEW.milestone_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT project_id INTO owner_project
  FROM milestones
  WHERE id = NEW.milestone_id AND organization_id = NEW.organization_id AND deleted_at IS NULL;

  IF owner_project IS NULL THEN
    RAISE EXCEPTION 'milestone % is not a live milestone of this organization', NEW.milestone_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'tasks_milestone_is_live';
  END IF;

  IF owner_project <> NEW.project_id THEN
    RAISE EXCEPTION 'milestone % belongs to another project', NEW.milestone_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'tasks_milestone_belongs_to_project';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER tasks_milestone_belongs_to_project
  BEFORE INSERT OR UPDATE OF milestone_id, project_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION sw_task_milestone_belongs_to_project();

-- "What is this milestone waiting on" — the read the project page makes for every milestone
-- it draws, and the one the column existed for.
CREATE INDEX tasks_milestone_idx
  ON tasks (organization_id, milestone_id)
  WHERE milestone_id IS NOT NULL AND deleted_at IS NULL;
