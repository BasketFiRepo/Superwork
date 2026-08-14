-- 0017 · Retention windows, and erasure that can actually be run
--
-- Migration 0009 taught `audit_logs` to refuse UPDATE from everybody and DELETE from the
-- application role, permitting DELETE by the owner role "which is how the retention and
-- erasure jobs — and ON DELETE CASCADE from a purged organization — can complete."
--
-- There was no retention job and no erasure job. The substrate was built and the thing it
-- was built for was not, so the product kept everything for ever while its own migration
-- described a policy engine that did not exist.
--
-- Two tables, because these are two different promises:
--
--   retention_policies — how long a class of data is kept, and why. A number somebody set,
--                        with their name on it, not a constant in a deploy.
--   erasure_requests   — one person's data, removed on request, with what was deleted, what
--                        was anonymised, and what was kept and on what basis. An erasure
--                        nobody can describe afterwards is not one anybody can rely on.

CREATE TABLE retention_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- One of the classes named in packages/core/src/retention.ts. Not an enum: adding a
  -- class is a code change that must ship with the query that purges it, and a database
  -- enum would let the value exist a release before the behaviour does.
  data_class      text NOT NULL,
  keep_days       integer NOT NULL,
  -- Why this number. A retention window without a reason is a number nobody can defend to
  -- a regulator or argue with internally.
  reason          text NOT NULL,
  set_by          uuid REFERENCES users(id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  last_applied_at timestamptz,
  last_purged     integer NOT NULL DEFAULT 0,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  -- A window has to be a real window. Zero would mean "delete everything continuously",
  -- which is not retention; the upper bound is a decade, past which "keep" means "for ever"
  -- and should be said out loud rather than expressed as 36500.
  CONSTRAINT retention_window_sane CHECK (keep_days BETWEEN 1 AND 3650),
  CONSTRAINT retention_reason_given CHECK (length(btrim(reason)) >= 8)
);
CREATE UNIQUE INDEX retention_policies_key
  ON retention_policies (organization_id, data_class) WHERE deleted_at IS NULL;

CREATE TABLE erasure_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Nullable so the row survives the erasure it describes: the subject's user row may be
  -- gone by the time anybody reads this. The label below is what remains, and it is
  -- deliberately not their name.
  subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_label   text NOT NULL,
  requested_by    uuid REFERENCES users(id),
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'previewed',
  -- What the erasure would do, computed before anything happens, and kept: a person
  -- consenting to an erasure is consenting to this list.
  preview         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What it did. Counts per table, and the tables deliberately left alone with the basis
  -- for keeping them.
  outcome         jsonb,
  completed_at    timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT erasure_status_known CHECK (status IN ('previewed', 'completed', 'refused')),
  CONSTRAINT erasure_reason_given CHECK (length(btrim(reason)) >= 8),
  -- A completed erasure that cannot say what it did is the failure this table exists to
  -- prevent, so the database refuses to record one.
  CONSTRAINT erasure_completed_has_outcome
    CHECK (status <> 'completed' OR (outcome IS NOT NULL AND completed_at IS NOT NULL)),
  -- The label must not be the person's name or address: this row outlives them on purpose,
  -- and an erasure record that carries the identity it erased is not an erasure.
  CONSTRAINT erasure_label_not_identifying CHECK (subject_label !~ '@')
);
CREATE INDEX erasure_requests_org_idx
  ON erasure_requests (organization_id, created_at DESC) WHERE deleted_at IS NULL;

SELECT sw_attach_touch(t) FROM (VALUES
  ('retention_policies'::regclass), ('erasure_requests')
) AS x(t);

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['retention_policies', 'erasure_requests'])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        AS PERMISSIVE FOR ALL TO superwork_app
        USING (organization_id = sw_current_org())
        WITH CHECK (organization_id = sw_current_org())
    $p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO superwork_app', t);
  END LOOP;
END
$$;
