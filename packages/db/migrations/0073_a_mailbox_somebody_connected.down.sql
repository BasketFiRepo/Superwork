DROP INDEX IF EXISTS email_accounts_sync_idx;
DROP INDEX IF EXISTS conversations_external_id_key;
DROP INDEX IF EXISTS messages_external_id_key;

DROP TRIGGER IF EXISTS email_accounts_owner_same_org_update ON email_accounts;
DROP TRIGGER IF EXISTS email_accounts_owner_same_org_insert ON email_accounts;
DROP FUNCTION IF EXISTS sw_mailbox_owner_same_org();

ALTER TABLE email_accounts ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE email_accounts
  DROP CONSTRAINT IF EXISTS email_accounts_trouble_is_explained,
  DROP CONSTRAINT IF EXISTS email_accounts_status_known;
