-- 0034 — The last two tables nothing had ever touched.
--
-- `saved_views` and `task_watchers` were created in migration 0002 and have never been read
-- or written by anything, including the seed. They are the only two of the six dead tables
-- worth building rather than dropping: a named filter is what a list screen is for, and
-- following work you do not own is the difference between an assignee-shaped product and one
-- a team can use.
--
-- The `query` column is a jsonb blob that a list screen would have to trust. It is validated
-- against the filters the list actually accepts, in the repository, and constrained here to
-- be an object at all — a saved view that expands to a filter nothing understands is a
-- button that quietly shows the wrong rows.

ALTER TABLE saved_views
  ADD CONSTRAINT saved_views_entity_known CHECK (entity IN ('task', 'inbox')),
  ADD CONSTRAINT saved_views_name_present CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT saved_views_query_is_object CHECK (jsonb_typeof(query) = 'object'),
  -- A view belongs to somebody. A row with no owner could not be edited or removed by
  -- anybody, which is how a list ends up with a filter nobody can get rid of.
  ADD CONSTRAINT saved_views_has_owner CHECK (user_id IS NOT NULL);

-- One name per person per list. Two "Mine, overdue" on the tasks screen is a menu where the
-- same word does two different things.
CREATE UNIQUE INDEX saved_views_one_name_per_person
  ON saved_views (organization_id, user_id, entity, lower(btrim(name)))
  WHERE deleted_at IS NULL;

-- The read the screen does on every page load: mine, plus anything shared with everybody.
CREATE INDEX saved_views_reader_idx
  ON saved_views (organization_id, entity, user_id, shared)
  WHERE deleted_at IS NULL;

/**
 * Both ends of a watch belong to this organization.
 *
 * `task_watchers` has no foreign key on `user_id` and none on `task_id`, and the fan-out
 * writes a notification to whoever the row names — so a row pointing at another tenant's
 * person would send them a sentence about a task they cannot see.
 */
CREATE OR REPLACE FUNCTION sw_task_watcher_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a watch must name a task in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = NEW.user_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a watch must name a member of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER task_watchers_same_org
  BEFORE INSERT OR UPDATE ON task_watchers
  FOR EACH ROW EXECUTE FUNCTION sw_task_watcher_same_org();

-- "What am I following", which is the read the person's own screen wants.
CREATE INDEX task_watchers_user_idx
  ON task_watchers (organization_id, user_id)
  WHERE deleted_at IS NULL;

-- A watcher hears that a task changed, which is a notification like any other.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed'
    ));
