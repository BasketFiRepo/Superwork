DROP INDEX IF EXISTS companies_name_idx;

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_name_said,
  DROP CONSTRAINT IF EXISTS contacts_emails_ok;

ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_name_said,
  DROP CONSTRAINT IF EXISTS companies_health_known,
  DROP CONSTRAINT IF EXISTS companies_sla_sane,
  DROP CONSTRAINT IF EXISTS companies_check_in_sane,
  DROP CONSTRAINT IF EXISTS companies_domains_ok;

DROP FUNCTION IF EXISTS sw_domain_list_ok(text[]);
DROP FUNCTION IF EXISTS sw_email_list_ok(text[]);
