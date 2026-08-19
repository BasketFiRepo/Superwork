-- 0048 — An organization that describes itself.
--
-- `organizations` has been written by the seed and by almost nothing else since Phase 0. Two
-- columns became settable along the way — `data_region` and `agent_kill_switch` — and the rest
-- of the row is whatever the seed said. So every organization is Northwind Logistics, in
-- Europe/London, that thinks a reefer is a temperature-controlled trailer.
--
-- The four that are read by live code and could not be changed:
--
--   `name`      the header of every screen, the grounding the model is given, and the name on
--               the transparency report a person can ask for about themselves.
--   `industry`  the other half of that grounding.
--   `timezone`  what "today" and "overdue" mean for everybody who has no timezone of their
--               own, plus the fallback for a department that sets none and the clock every
--               recurring task is rolled on.
--   `glossary`  expanded into every search query before it is embedded, so the acronyms a
--               company actually says find the documents that spell them out.
--
-- Two more are read by nothing, which is a different failure and is fixed the other way round:
-- `currency` was formatted as GBP for everybody because `formatCents` has a currency parameter
-- and no caller passed one, and `profile.tone` was set by the seed and consulted nowhere. Both
-- are given a reader in this change rather than a settings field that does nothing.
--
-- The `slug` is deliberately not settable: it is an address, and changing an address silently
-- breaks every link anybody kept.

-- A name that is two characters is a name somebody could be looking at and not recognise, but
-- the rule here is only about a name existing at all.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_name_said CHECK (length(btrim(name)) >= 2),
  -- ISO 4217 is three capital letters. The set of real codes is not the database's business —
  -- the shape of one is, because `Intl.NumberFormat` throws on anything else and the throw
  -- would land in whichever screen was formatting money at the time.
  ADD CONSTRAINT organizations_currency_code CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT organizations_timezone_said CHECK (length(btrim(timezone)) >= 3);

/**
 * The glossary is a list of terms and what they mean, and both halves have to be real.
 *
 * `transformQuery` builds a word-boundary regular expression out of every term and appends the
 * meaning when it matches. An empty term compiles to `\b\b`, which matches every query, so a
 * single blank entry would append its meaning to every search anybody ever ran — the one
 * failure here that is not merely untidy. A one-character term is nearly as bad.
 *
 * Terms are distinct case-insensitively, because two entries for the same term append their
 * meanings twice and nobody meant to say a thing twice.
 */
CREATE OR REPLACE FUNCTION sw_glossary_ok(entries jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(entries) <> 'array' THEN false
    WHEN jsonb_array_length(entries) > 200 THEN false
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(entries) AS entry
      WHERE jsonb_typeof(entry) <> 'object'
         OR jsonb_typeof(entry->'term') <> 'string'
         OR jsonb_typeof(entry->'meaning') <> 'string'
         OR length(btrim(entry->>'term')) < 2
         OR length(entry->>'term') > 40
         OR length(btrim(entry->>'meaning')) < 2
         OR length(entry->>'meaning') > 200
    ) THEN false
    ELSE (
      SELECT count(DISTINCT lower(btrim(entry->>'term'))) = jsonb_array_length(entries)
      FROM jsonb_array_elements(entries) AS entry
    )
  END
$$;

/**
 * The profile is how the organization describes itself to the model. Only `tone` is read; the
 * rest of what the seed writes there is left alone rather than deleted, because a column that
 * quietly loses keys it was not asked about is worse than one that carries a few unused.
 */
CREATE OR REPLACE FUNCTION sw_org_profile_ok(profile jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(profile) <> 'object' THEN false
    WHEN profile ? 'tone' AND (
      jsonb_typeof(profile->'tone') <> 'string' OR length(profile->>'tone') > 400
    ) THEN false
    ELSE true
  END
$$;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_glossary_valid CHECK (sw_glossary_ok(glossary)),
  ADD CONSTRAINT organizations_profile_valid CHECK (sw_org_profile_ok(profile));
