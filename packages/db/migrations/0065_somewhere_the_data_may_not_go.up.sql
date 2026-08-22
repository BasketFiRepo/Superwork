-- 0065 — Somewhere the data may not go.
--
-- `organizations.allowed_regions` was added in 0011 with `DEFAULT ARRAY['eu']` and nothing has
-- ever written it. It is not decorative: `residency()` reads it, the settings screen renders every
-- region against it, `setResidency()` refuses a move to a region that is not on it, and the schema
-- refuses one too — `CHECK (data_region = ANY (allowed_regions))`.
--
-- So the data-residency panel offers three regions to every organization, permanently refuses two
-- of them, and the refusal reads:
--
--     This organization is provisioned for eu. Moving to uk is a migration, not a setting.
--
-- naming a provisioning act that nobody, anywhere in this product, can perform. A refusal has to
-- name what would work, and that one names something that cannot be done.
--
-- The obvious repair — let an administrator tick "us" — is the wrong one, and for the reason §25
-- gives about fake integration buttons: a settings screen cannot make infrastructure exist. An
-- organization ticking a region it has no database in would be recording a claim about the world
-- that is simply untrue, and `data_region` would then be free to move somewhere there is nothing
-- to move to.
--
-- The shape this needs already exists in the product, one screen away. `plan_limits` holds the
-- vendor's ceiling and `subscriptions` holds the customer's own cap beneath it, and `setCaps`
-- says the rule out loud: "an organization may tighten its limits, never widen them — changing
-- the plan is a commercial change, not a setting."
--
-- Regions are the same arrangement with a different ceiling.

/**
 * Where this organization *could* keep its data: the regions somebody actually provisioned.
 *
 * Operational, not a setting. It is written where provisioning happens — seeding, a migration, an
 * administrator on the owner connection — and never by the tenant runtime, which is why no repository
 * function updates it and no screen offers to. Superwork can enforce a promise about where data
 * goes; it cannot conjure a database in Ohio because somebody ticked a box.
 *
 * Defaulting to what every existing row already claims, so this migration changes nothing about
 * where anybody's data may live.
 */
ALTER TABLE organizations
  ADD COLUMN provisioned_regions text[] NOT NULL DEFAULT ARRAY['eu'];

UPDATE organizations SET provisioned_regions = allowed_regions;

/**
 * And where the organization has said it *may* go, which is its own to narrow.
 *
 * "Our data must never leave the EU" is a real thing a company wants to be able to say and have
 * enforced, and until now the only way to say it was to already be in the one region the default
 * allowed. Narrowing is the customer's call and needs no proof; widening back up to the ceiling
 * asks for a password because it widens; widening past the ceiling is refused, because that is
 * the half a settings screen cannot make true.
 */
ALTER TABLE organizations
  ADD CONSTRAINT allowed_within_provisioned
    CHECK (allowed_regions <@ provisioned_regions),
  ADD CONSTRAINT allowed_regions_not_empty
    CHECK (cardinality(allowed_regions) >= 1);

-- The attribution triple (ADR 0044 onward). A restriction on where a company's data may go is
-- exactly the kind of setting somebody is asked about a year later, in a room where the answer
-- "it has always been like that" is not one.
ALTER TABLE organizations
  ADD COLUMN allowed_regions_set_by uuid REFERENCES users(id),
  ADD COLUMN allowed_regions_set_at timestamptz,
  ADD COLUMN allowed_regions_reason text,
  ADD CONSTRAINT allowed_regions_attributed
    CHECK (
      (allowed_regions_set_by IS NULL) = (allowed_regions_set_at IS NULL)
      AND (allowed_regions_set_at IS NULL) = (allowed_regions_reason IS NULL)
    );
