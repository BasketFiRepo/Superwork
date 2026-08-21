-- Undoes 0065.
--
-- `allowed_regions` and its `data_region_allowed` CHECK belong to 0011 and stay. What goes is the
-- ceiling above it, the rules that hold it beneath that ceiling, and the record of who narrowed it
-- and why — after which the column is once again something nothing in the product can write.
--
-- Any organization that had narrowed itself keeps the narrower set: dropping the ceiling is not a
-- reason to widen where somebody's data may go, and this script does not do it.

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS allowed_regions_attributed,
  DROP COLUMN IF EXISTS allowed_regions_reason,
  DROP COLUMN IF EXISTS allowed_regions_set_at,
  DROP COLUMN IF EXISTS allowed_regions_set_by;

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS allowed_regions_not_empty,
  DROP CONSTRAINT IF EXISTS allowed_within_provisioned,
  DROP COLUMN IF EXISTS provisioned_regions;
