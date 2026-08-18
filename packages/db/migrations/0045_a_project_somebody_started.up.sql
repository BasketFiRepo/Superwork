-- 0045 — A project somebody started.
--
-- `projects` has been read on every screen since Phase 1 — the list, the health score, the task
-- rows that carry a project's classification, the milestones filed against it (ADR 0048) — and
-- written by the seed alone. There is no `createProject` anywhere in the product, so a company
-- using Superwork could work on exactly the projects a demo fixture happened to invent.
--
-- Two rules a project has always implied and nothing enforced:
--
--   **A target date is not before the start.** The health score reads both, and a project whose
--   target precedes its start makes every number computed from them meaningless rather than
--   wrong-in-a-visible-way.
--
--   **Two open projects do not share a name.** People refer to projects by name in a sentence —
--   "put it on the Halden one" — and two live projects with the same name make that sentence
--   ambiguous to a person and to the assistant. The index covers open projects only, so a name
--   is free again once the project it belonged to is completed or cancelled: "Q1 finance close"
--   comes round every year, and refusing it for ever would be a rule about the wrong thing.

ALTER TABLE projects
  ADD CONSTRAINT projects_dates_in_order
    CHECK (target_date IS NULL OR starts_on IS NULL OR target_date >= starts_on);

CREATE UNIQUE INDEX projects_one_open_name
  ON projects (organization_id, lower(btrim(name)))
  WHERE deleted_at IS NULL AND status NOT IN ('completed', 'cancelled');
