-- 0047 — Days this office is closed.
--
-- Migration 0036 gave a department a working calendar and the nudge ladder started obeying
-- it: nobody is chased on a Saturday or on Christmas Day any more. What it gave was a choice
-- between four names — `none`, `weekends`, `uk-england-wales`, `us-federal` — and the dates
-- behind each are computed from published national rules. A department cannot say a single
-- day of its own.
--
-- That gap is not exotic. It is the week between Christmas and New Year that most of the
-- country takes and no statute names. It is the Monday the depot moves. It is every public
-- holiday of every country that is not England, Wales, or the United States, which is to say
-- most of them: a French department can pick `weekends` and is then chased through the
-- fourteenth of July.
--
-- So a closure is a date a department names for itself, and it only ever *adds* a day nobody
-- works. There is no row here that makes somebody workable on a day their calendar says they
-- are not — the guarantee ADR 0039 made was that this feature may only quieten the product,
-- and a table that could switch a bank holiday back on would take that guarantee away.
--
-- Closures accumulate down the tree rather than overriding, which is the opposite of the
-- calendar above them and is right for both: one calendar governs a person, but a company
-- shutdown and a depot's own closed day are both true at once.

CREATE TABLE department_closures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The department it is declared on. Everything under that department inherits it.
  department_id   uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  closed_on       date NOT NULL,
  -- What the day is, in the words the people not working it would use. It is shown to them
  -- on their own reminders screen and it is the reason a held reminder carries, so an empty
  -- one would produce "Not delivered: where they work."
  label           text NOT NULL,
  -- A closure has no default. Every one of these rows is a day somebody chose, so unlike
  -- the attributed settings of ADRs 0044 and 0046 there is no "nobody set this" case to
  -- represent: the column is NOT NULL rather than nullable with a story about it.
  set_by          uuid NOT NULL REFERENCES users(id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  -- Taking a closure away is the widening direction: people are chased on a day the company
  -- had said it was shut. It stays as a row that says who reopened it and why, rather than
  -- disappearing, for the same reason releasing a legal hold does.
  reopened_by     uuid REFERENCES users(id),
  reopened_at     timestamptz,
  reopen_reason   text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT department_closures_label CHECK (length(btrim(label)) >= 3 AND length(label) <= 80),
  -- A four-digit typo in the year would otherwise store a day in the year 202 and quietly
  -- never arrive. The range is deliberately wide: it refuses nonsense, not planning.
  CONSTRAINT department_closures_plausible
    CHECK (closed_on >= DATE '2020-01-01' AND closed_on < DATE '2100-01-01'),
  CONSTRAINT department_closures_reopening CHECK (
    (deleted_at IS NULL AND reopened_by IS NULL AND reopened_at IS NULL AND reopen_reason IS NULL)
    OR (deleted_at IS NOT NULL AND reopened_by IS NOT NULL AND reopened_at IS NOT NULL
        AND length(btrim(reopen_reason)) >= 4)
  )
);

-- One closure per department per day, and the lookup the delivery gate does for every
-- reminder. A second row for the same day would mean two labels for one closed day and no
-- way to say which of them a held reminder is quoting.
CREATE UNIQUE INDEX department_closures_one_per_day
  ON department_closures (organization_id, department_id, closed_on)
  WHERE deleted_at IS NULL;

SELECT sw_attach_touch('department_closures'::regclass);

ALTER TABLE public.department_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_closures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.department_closures
  AS PERMISSIVE FOR ALL TO superwork_app
  USING (organization_id = sw_current_org())
  WITH CHECK (organization_id = sw_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.department_closures TO superwork_app;
