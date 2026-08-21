-- 0057 — Work a team can hold.
--
-- Migration 0022 added `team_id` to tasks, projects and documents, indexed all three, and
-- said the point out loud: every grant the `guest` role holds is team-scoped, so without a
-- team dimension that role can read nothing. It then gave the product a writer for exactly
-- one of the three columns.
--
-- So a team could be created, people could be added to it, and then it ended. `projects.team_id`
-- has never been written by anything in the product; `documents.team_id` only by the seed and
-- by tests reaching past the product with an owner connection. Which means:
--
--   * `project:read:team` and `document:read:team` — half of what a guest holds — matched no
--     row that any product action could produce;
--   * the Teams screen counts tasks, projects and documents scoped to each team, and two of
--     those three numbers could only ever be zero;
--   * `archiveTeam` refuses to disband a team "while anything is still scoped to it", and for
--     two of the three kinds of thing that condition could never arise;
--   * retrieval filters passages by `d.team_id = ANY(actor.teamIds)`, so a guest's assistant
--     could find nothing either.
--
-- The columns stay nullable, for the reason 0022 gave: most work belongs to a department and
-- a person, and forcing a team onto it would be inventing structure to satisfy a schema.

/**
 * Work is scoped to a live team in its own organization.
 *
 * The same guarantee `sw_task_watcher_same_org` and `sw_conversation_assignee_same_org` make,
 * for the same reason: a foreign key to `teams` says the team exists and says nothing at all
 * about which organization it is in. A document scoped to another tenant's team would be
 * invisible to every team-scoped reader here, present in that tenant's team counts, and
 * perfectly ordinary in the row.
 *
 * `deleted_at IS NULL` is the second half. Disbanding a team is refused while work is scoped
 * to it, so the pair means a team and the work in it can never disagree about which of them
 * exists.
 */
CREATE OR REPLACE FUNCTION sw_team_scope_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM teams
    WHERE id = NEW.team_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'work can only be scoped to a live team in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Two triggers per table rather than one on INSERT OR UPDATE, and the difference matters.
--
-- The check has to run when the value arrives, not on every later edit: a soft-deleted task
-- does not count towards `archiveTeam`'s guard, so a team can be disbanded while a deleted row
-- still points at it — and a single BEFORE INSERT OR UPDATE trigger would then refuse every
-- future edit of that row, including the one restoring it. Gating the update trigger on the
-- value actually changing keeps the guarantee about writes of `team_id` and says nothing about
-- writes of anything else.

CREATE TRIGGER tasks_team_same_org_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW WHEN (NEW.team_id IS NOT NULL)
  EXECUTE FUNCTION sw_team_scope_same_org();

CREATE TRIGGER tasks_team_same_org_update
  BEFORE UPDATE ON tasks
  FOR EACH ROW WHEN (NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM OLD.team_id)
  EXECUTE FUNCTION sw_team_scope_same_org();

CREATE TRIGGER projects_team_same_org_insert
  BEFORE INSERT ON projects
  FOR EACH ROW WHEN (NEW.team_id IS NOT NULL)
  EXECUTE FUNCTION sw_team_scope_same_org();

CREATE TRIGGER projects_team_same_org_update
  BEFORE UPDATE ON projects
  FOR EACH ROW WHEN (NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM OLD.team_id)
  EXECUTE FUNCTION sw_team_scope_same_org();

CREATE TRIGGER documents_team_same_org_insert
  BEFORE INSERT ON documents
  FOR EACH ROW WHEN (NEW.team_id IS NOT NULL)
  EXECUTE FUNCTION sw_team_scope_same_org();

CREATE TRIGGER documents_team_same_org_update
  BEFORE UPDATE ON documents
  FOR EACH ROW WHEN (NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM OLD.team_id)
  EXECUTE FUNCTION sw_team_scope_same_org();
