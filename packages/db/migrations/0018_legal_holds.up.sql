-- 0018 — Legal holds.
--
-- Migration 0017 gave the organization a way to delete on a schedule. This gives it a way
-- to stop, which is the other half of the same obligation: an organization that cannot
-- suspend its own retention when a matter arises destroys evidence on a timer, and that is
-- a worse failure than keeping too much.
--
-- A hold is a promise not to delete, so it is stored as a row that the purge consults
-- rather than as a flag on the records it protects. Flagging every affected row would mean
-- the hold could only ever cover records that existed when it was placed; a matter covers
-- what arrives afterwards too.
--
-- `custodian_ids` empty means everybody, which is what a whole-organization hold is. It is
-- a `uuid[]` rather than a join table because the purge consults it inside a correlated
-- subquery on every class, and an array containment test is one index-free comparison
-- against a handful of rows rather than a second join per class.
--
-- `covers_to` NULL means "and everything since". A live matter has no end date, and
-- writing one in would quietly stop preserving on a day nobody chose.

CREATE TABLE legal_holds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The matter, in the words the organization's own counsel would use for it.
  matter          text NOT NULL,
  -- Why there is a hold at all: the notice, the claim, the regulator, the date.
  basis           text NOT NULL,
  -- Empty means every person in the organization.
  custodian_ids   uuid[] NOT NULL DEFAULT '{}',
  covers_from     timestamptz NOT NULL,
  covers_to       timestamptz,
  placed_by       uuid REFERENCES users(id),
  placed_at       timestamptz NOT NULL DEFAULT now(),
  released_by     uuid REFERENCES users(id),
  released_at     timestamptz,
  release_reason  text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT legal_holds_matter CHECK (length(btrim(matter)) >= 3),
  -- A hold without a basis is indistinguishable from indefinite retention of one person's
  -- records, which is the thing §29.5 exists to prevent.
  CONSTRAINT legal_holds_basis CHECK (length(btrim(basis)) >= 12),
  CONSTRAINT legal_holds_period CHECK (covers_to IS NULL OR covers_to > covers_from),
  -- Releasing re-exposes records to deletion, so the reason travels with the release and
  -- neither can exist without the other.
  CONSTRAINT legal_holds_release CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND release_reason IS NOT NULL AND length(btrim(release_reason)) >= 8)
  )
);

-- The purge consults live holds on every class on every sweep, so that is the index.
CREATE INDEX legal_holds_live_idx ON legal_holds (organization_id, covers_from)
  WHERE released_at IS NULL AND deleted_at IS NULL;
CREATE INDEX legal_holds_custodian_idx ON legal_holds USING gin (custodian_ids);

-- What a sweep left alone, alongside what it removed. A hold nobody can see working is
-- indistinguishable from a hold that is not working.
ALTER TABLE retention_policies ADD COLUMN last_held integer NOT NULL DEFAULT 0;

SELECT sw_attach_touch('legal_holds'::regclass);

ALTER TABLE public.legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.legal_holds
  AS PERMISSIVE FOR ALL TO superwork_app
  USING (organization_id = sw_current_org())
  WITH CHECK (organization_id = sw_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_holds TO superwork_app;
