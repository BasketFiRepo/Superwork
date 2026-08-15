-- 0023 — Making a feature flag override storable.
--
-- `feature_flag_overrides` is the odd one out among the tables nothing writes to, because
-- the *read* path was finished: `apps/web/src/lib/session.ts` loads this table on every
-- request, separates the organization-wide rows from the per-user ones, and layers them
-- over `DEFAULT_FLAGS`. That code has run on every page load since Phase 0 and has never
-- had a row to find.
--
-- The consequence is quiet rather than broken: every organization has had exactly the same
-- features, and no administrator could change one. The flags are not decoration — the
-- sidebar renders a nav item as a disabled "Soon" when its flag is off — so what was
-- missing is the ability to turn anything off or on at all.
--
-- Two things this needs before it can be used.

-- A flag name that is not a flag is a row that will never match anything and will never be
-- noticed, because the resolver simply layers unknown keys onto an object nobody reads. The
-- list is duplicated from packages/config/src/flags.ts on purpose: the database is where a
-- typo has to be stopped, and a test asserts the two lists agree so they cannot drift.
ALTER TABLE feature_flag_overrides
  ADD CONSTRAINT feature_flag_known CHECK (
    flag IN (
      'inbox', 'meetings', 'crm', 'workflows', 'insights',
      'reports', 'autopilot', 'chat_presence', 'public_api', 'compact_density'
    )
  );

-- Why somebody turned a feature off for an organization, and who. Without it the row is an
-- unexplained difference between two tenants that the next engineer will assume is a bug.
ALTER TABLE feature_flag_overrides ADD COLUMN reason text;
ALTER TABLE feature_flag_overrides ADD COLUMN set_by uuid REFERENCES users(id);

-- The session reads this on every request, filtered to organization-wide rows plus this
-- user's. The existing unique index is on (organization_id, coalesce(user_id,…), flag),
-- which cannot serve that lookup.
CREATE INDEX feature_flag_lookup_idx
  ON feature_flag_overrides (organization_id, user_id)
  WHERE deleted_at IS NULL;
