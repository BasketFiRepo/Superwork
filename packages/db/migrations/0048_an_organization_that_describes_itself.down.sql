ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_glossary_valid,
  DROP CONSTRAINT IF EXISTS organizations_profile_valid,
  DROP CONSTRAINT IF EXISTS organizations_name_said,
  DROP CONSTRAINT IF EXISTS organizations_currency_code,
  DROP CONSTRAINT IF EXISTS organizations_timezone_said;

DROP FUNCTION IF EXISTS sw_glossary_ok(jsonb);
DROP FUNCTION IF EXISTS sw_org_profile_ok(jsonb);
