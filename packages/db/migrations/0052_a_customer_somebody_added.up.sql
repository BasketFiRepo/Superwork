-- 0052 — A customer somebody added.
--
-- `companies` and `contacts` are read everywhere: the companies screen, the relationship view,
-- the inbox's routing, the watchers that ask whether a customer has gone quiet, and the ACL that
-- decides who may see either. Both have been written by the seed and by nothing else since
-- Phase 0. There is no way to add a customer to this product.
--
-- Neither table has ever carried a single CHECK, which is why the fields the product acts on
-- could be anything at all:
--
--   `domains`         decides which company an inbound address belongs to (`companyForAddress`).
--                     An entry with an `@` in it, or a bare word, silently matches nothing; two
--                     companies claiming the same domain make the answer arbitrary.
--   `reply_sla_days`  is how long a thread may go unanswered before somebody is chased.
--   `check_in_days`   is how long a customer may go quiet before the same happens.
--   `health_status`   is shown against the account.
--   `sensitivity`     is what the ACL reads to decide who may see the record at all.
--
-- A zero in either of the two day counts means "chase immediately, for ever", which is not
-- something anybody would choose on purpose.

ALTER TABLE companies
  ADD CONSTRAINT companies_name_said CHECK (length(btrim(name)) >= 2),
  ADD CONSTRAINT companies_health_known
    CHECK (health_status IN ('unknown', 'healthy', 'at_risk', 'critical')),
  -- One day is the tightest promise worth making and ninety is a quarter; outside that the
  -- number is a typo rather than a policy.
  ADD CONSTRAINT companies_sla_sane CHECK (reply_sla_days BETWEEN 1 AND 90),
  ADD CONSTRAINT companies_check_in_sane CHECK (check_in_days BETWEEN 1 AND 365);

/**
 * A domain list that can actually match an address.
 *
 * `companyForAddress` splits an address at the `@` and looks for the remainder in this array, so
 * an entry containing an `@`, an entry with no dot, or one with different case matches nothing —
 * and the failure is silent: mail from a customer simply stops being attributed to them.
 */
CREATE OR REPLACE FUNCTION sw_domain_list_ok(domains text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN array_length(domains, 1) IS NULL THEN true
    WHEN array_length(domains, 1) > 20 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM unnest(domains) AS domain
      WHERE domain <> lower(domain)
         OR domain !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    )
  END
$$;

ALTER TABLE companies
  ADD CONSTRAINT companies_domains_ok CHECK (sw_domain_list_ok(domains));

/**
 * An address list where every entry is one.
 *
 * Duplicates *across* contacts are deliberately not refused here: two records for the same person
 * is what the merge queue is for (§8.4), and a unique index would refuse the row the queue exists
 * to notice. The repository says who the other one is instead.
 */
CREATE OR REPLACE FUNCTION sw_email_list_ok(emails text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN array_length(emails, 1) IS NULL THEN true
    WHEN array_length(emails, 1) > 10 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM unnest(emails) AS address
      WHERE address <> lower(address)
         OR address !~ '^[^@[:space:]]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    )
  END
$$;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_name_said CHECK (length(btrim(name)) >= 2),
  ADD CONSTRAINT contacts_emails_ok CHECK (sw_email_list_ok(emails));

-- Finding a company by name, for the refusal that says one already exists. The screens list by
-- name and search by it, and neither had an index for it.
CREATE INDEX companies_name_idx ON companies (organization_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;
