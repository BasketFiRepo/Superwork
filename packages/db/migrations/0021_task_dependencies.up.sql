-- 0021 — Making a task dependency mean something.
--
-- `task_dependencies` was created in migration 0002 and nothing has ever written to it. The
-- daily briefing reads it — the "your work is blocking other people" section runs an
-- EXISTS against this table on every briefing generated — so that section has been
-- structurally empty since Phase 2, for every user, on every day.
--
-- Two things were missing to make it usable.
--
-- The index. Every read of this table so far goes the *reverse* way: "which tasks are
-- waiting on this one". The only index was on (task_id, depends_on_task_id), which cannot
-- serve that, so the briefing's subquery was a sequential scan over a table whose emptiness
-- was the only reason nobody noticed.
--
-- And the cycle check. A dependency graph with a cycle is a set of tasks none of which can
-- ever be completed, and every one of them will report that it is waiting for another. That
-- is not a validation error to be surfaced politely at the API — it is a state the database
-- must refuse to hold, because the thing that eventually writes a cycle is a bulk import or
-- an agent, not a person clicking a button.

CREATE INDEX task_dependencies_blocking_idx
  ON task_dependencies (organization_id, depends_on_task_id)
  WHERE deleted_at IS NULL;

/**
 * Refuses an edge that would close a loop.
 *
 * The edge says `task_id` waits for `depends_on_task_id`. A cycle exists if the task being
 * waited *for* is already — directly or transitively — waiting for the task doing the
 * waiting. So the walk starts at the new prerequisite and follows what it in turn depends
 * on; reaching the dependent task means the loop would close.
 *
 * The recursion is bounded by the unique index: an edge cannot repeat, so a finite graph
 * gives a finite walk. The depth cap is a second belt for the case where somebody removes
 * that index in a later migration and does not think about this one.
 */
CREATE OR REPLACE FUNCTION sw_task_dependency_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closes_loop boolean;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE reachable(task_id, depth) AS (
    SELECT NEW.depends_on_task_id, 0
    UNION ALL
    SELECT d.depends_on_task_id, r.depth + 1
    FROM task_dependencies d
    JOIN reachable r ON d.task_id = r.task_id
    WHERE d.deleted_at IS NULL AND r.depth < 100
  )
  SELECT EXISTS (SELECT 1 FROM reachable WHERE task_id = NEW.task_id) INTO closes_loop;

  IF closes_loop THEN
    RAISE EXCEPTION 'that dependency would create a loop, and neither task could ever be completed'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER task_dependencies_no_cycle
  BEFORE INSERT OR UPDATE ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION sw_task_dependency_no_cycle();

-- Both ends of a dependency must be the same organization's tasks. RLS already stops one
-- tenant reading another's rows, but nothing stopped a row *referencing* across the
-- boundary, and the FKs are to `tasks(id)` with no tenant in them.
CREATE OR REPLACE FUNCTION sw_task_dependency_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ends integer;
BEGIN
  SELECT count(*) INTO ends FROM tasks
  WHERE id IN (NEW.task_id, NEW.depends_on_task_id) AND organization_id = NEW.organization_id;

  IF ends <> 2 THEN
    RAISE EXCEPTION 'both tasks in a dependency must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER task_dependencies_same_org
  BEFORE INSERT OR UPDATE ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION sw_task_dependency_same_org();

-- Why one task waits for another. Without it a dependency is an assertion nobody can
-- evaluate later, and the first person to hit it just deletes it.
ALTER TABLE task_dependencies ADD COLUMN reason text;
