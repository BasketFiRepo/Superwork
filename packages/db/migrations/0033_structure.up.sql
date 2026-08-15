-- 0033 — Three things the product shows and could not create.
--
-- `departments` is read everywhere — it is one of the four permission scopes, it routes the
-- run queue's fair share, it scopes agent grants, and every person has one. `milestones` are
-- on every project page and are counted in the health score. `knowledge_spaces` are listed,
-- shared, filed into and cited. All three are written by the seed and by nothing else, so a
-- real organization could look at them and never make one.
--
-- The department tree also carries two derived columns, `path` and `depth`, which the seed
-- writes by hand. Nothing keeps them true: a department moved under a different parent would
-- keep the old path, and the screens that read `path` would keep showing the old place.

-- ---------------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------------

-- One name per parent. Two "Operations" under the same parent is a tree nobody can navigate
-- and a `path` that no longer identifies a row.
CREATE UNIQUE INDEX departments_one_name_per_parent
  ON departments (organization_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)))
  WHERE deleted_at IS NULL;

CREATE INDEX departments_parent_idx
  ON departments (organization_id, parent_id)
  WHERE deleted_at IS NULL;

/**
 * A parent in the same organization, and no loops.
 *
 * `parent_id` has no foreign key and is matched against departments elsewhere, so a row
 * pointing at another tenant's department would put a person under somebody else's tree —
 * and the `department` permission scope resolves against exactly that.
 */
CREATE OR REPLACE FUNCTION sw_department_parent_sane() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cursor_id uuid;
  hops integer := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'a department cannot be its own parent' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM departments
    WHERE id = NEW.parent_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a department must sit under one of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Walk up from the proposed parent. Meeting this row means the move would close a loop,
  -- and a tree with a loop is one that `path` cannot describe and a recursive read cannot
  -- finish.
  cursor_id := NEW.parent_id;
  WHILE cursor_id IS NOT NULL AND hops < 100 LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'that move would put a department underneath itself'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cursor_id FROM departments WHERE id = cursor_id;
    hops := hops + 1;
  END LOOP;

  RETURN NEW;
END
$$;

CREATE TRIGGER departments_parent_sane
  BEFORE INSERT OR UPDATE OF parent_id ON departments
  FOR EACH ROW EXECUTE FUNCTION sw_department_parent_sane();

/**
 * Keeps `path` and `depth` true, for this row and everything under it.
 *
 * They are derived from the parent, and the seed wrote them by hand. Deriving them in the
 * database rather than in whichever caller happens to move a department is the same decision
 * as the jurisdiction history (ADR 0028) and the project owner (ADR 0032): when two places
 * must agree, the agreement is not something application code should be trusted to remember.
 */
CREATE OR REPLACE FUNCTION sw_department_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_path text;
  parent_depth integer;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := btrim(NEW.name);
    NEW.depth := 0;
  ELSE
    SELECT path, depth INTO parent_path, parent_depth FROM departments WHERE id = NEW.parent_id;
    NEW.path := coalesce(parent_path, '') || ' / ' || btrim(NEW.name);
    NEW.depth := coalesce(parent_depth, 0) + 1;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER departments_path
  BEFORE INSERT OR UPDATE OF name, parent_id ON departments
  FOR EACH ROW EXECUTE FUNCTION sw_department_path();

/** And everything underneath follows, so a rename is not a lie one level down. */
CREATE OR REPLACE FUNCTION sw_department_path_cascade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path OR NEW.depth IS DISTINCT FROM OLD.depth THEN
    UPDATE departments child
    SET path = NEW.path || ' / ' || btrim(child.name),
        depth = NEW.depth + 1,
        updated_at = now()
    WHERE child.parent_id = NEW.id AND child.deleted_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;

-- Fires on any update rather than `OF path, depth`: that clause names the columns the
-- *statement* touched, and `path` is set by the BEFORE trigger above, so a rename would
-- never have reached the rows underneath.
CREATE TRIGGER departments_path_cascade
  AFTER UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION sw_department_path_cascade();

-- Bring the seeded rows into step with what the triggers would have written.
UPDATE departments SET name = name WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Milestones
-- ---------------------------------------------------------------------------

-- The three states a milestone can be in. `status` was free text, and the health score reads
-- it: anything that is not 'done' and past its date counts as slipping.
ALTER TABLE milestones
  ADD CONSTRAINT milestones_status_known CHECK (status IN ('open', 'done', 'cancelled')),
  ADD CONSTRAINT milestones_name_present CHECK (length(btrim(name)) > 0);

-- When it was reached, and by whom. A milestone that flipped to 'done' with nothing beside
-- it cannot answer the only question anybody asks about a milestone after the fact.
ALTER TABLE milestones
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN completed_by uuid REFERENCES users(id),
  ADD CONSTRAINT milestones_done_has_time CHECK ((status = 'done') = (completed_at IS NOT NULL));

CREATE UNIQUE INDEX milestones_one_name_per_project
  ON milestones (project_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;

CREATE INDEX milestones_project_due_idx
  ON milestones (organization_id, project_id, due_on)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Knowledge spaces
-- ---------------------------------------------------------------------------

ALTER TABLE knowledge_spaces
  ADD CONSTRAINT knowledge_spaces_name_present CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT knowledge_spaces_sensitivity_known
    CHECK (default_sensitivity IN ('public', 'internal', 'confidential', 'restricted'));

-- One shelf per name, and one per slug. The slug is what a link uses.
CREATE UNIQUE INDEX knowledge_spaces_one_name
  ON knowledge_spaces (organization_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX knowledge_spaces_one_slug
  ON knowledge_spaces (organization_id, slug)
  WHERE deleted_at IS NULL;
