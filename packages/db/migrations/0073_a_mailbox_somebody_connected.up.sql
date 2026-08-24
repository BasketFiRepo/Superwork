-- 0073 — A mailbox somebody connected.
--
-- `EmailProvider` declares three methods. `send` and `recall` are used everywhere. The third:
--
--     sync(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string | null }>
--
-- `MockEmailProvider.sync()` implements it, and nothing in the product has ever called it. The
-- `InboundMessage` type is referenced by exactly one file — the mock that produces it.
--
-- That one gap explains the whole remaining dead-column cluster. `email_accounts` has nine columns
-- nothing writes — `user_id`, `address`, `provider`, `status`, `scopes`, `sync_cursor`,
-- `last_sync_at`, `last_error`, `token_expires_at` — which is precisely the state a sync loop
-- needs, down to the cursor and the error field. `messages.external_id` and
-- `conversations.external_id` are dead too, and they are exactly what an inbound message carries
-- for dedupe and threading.
--
-- Meanwhile the inbox is fully built and fed by hand: ADR 0076 added `recordCorrespondence` so a
-- person could type in an email they had already received.
--
-- So "abstractions before integrations" was half-honoured. The abstraction was designed and the
-- mock was written; the consumer never was. Nothing here needs a credential — the mock is the
-- point, and it now delivers inbound mail instead of returning an empty list.

-- ---------------------------------------------------------------------------------------------
-- A connection that says how it is

-- Four states, and the three that are not `connected` have to say why. A mailbox that stopped
-- syncing three days ago and shows an inbox that quietly went stale is the classic integration
-- lie; §5.6's failure taxonomy exists so the product can tell somebody instead.
--
-- `last_error IS NOT NULL` is written out rather than left to `length()`. A CHECK passes when its
-- expression is TRUE **or NULL**, so `length(btrim(NULL)) > 0` would have accepted exactly the row
-- this refuses — the bug ADR 0082 shipped and this migration is written to avoid.
ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_status_known CHECK (
    status IN ('connected', 'expired', 'revoked', 'error')
  );

ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_trouble_is_explained CHECK (
    status = 'connected'
    OR (last_error IS NOT NULL AND length(btrim(last_error)) > 0)
  );

-- A mailbox belongs to the person whose mailbox it is (ADR 0084). `user_id` was nullable, which
-- would have allowed an organization-wide connection nobody owns — and a mailbox connected *for*
-- somebody, by somebody else, is the surveillance switch §29.5 exists to make unbuildable.
UPDATE email_accounts SET user_id = created_by WHERE user_id IS NULL AND created_by IS NOT NULL;
DELETE FROM email_accounts WHERE user_id IS NULL;
ALTER TABLE email_accounts ALTER COLUMN user_id SET NOT NULL;

-- And that person has to be a member here. The fifth writing of this rule: a foreign key to
-- `users` reaches every tenant, so on its own it says almost nothing.
CREATE OR REPLACE FUNCTION sw_mailbox_owner_same_org() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships mm
    WHERE mm.user_id = NEW.user_id
      AND mm.organization_id = NEW.organization_id
      AND mm.deleted_at IS NULL AND mm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'a mailbox can only belong to an active member of this organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_accounts_owner_same_org_insert
  BEFORE INSERT ON email_accounts
  FOR EACH ROW EXECUTE FUNCTION sw_mailbox_owner_same_org();

CREATE TRIGGER email_accounts_owner_same_org_update
  BEFORE UPDATE ON email_accounts
  FOR EACH ROW WHEN (NEW.user_id IS DISTINCT FROM OLD.user_id)
  EXECUTE FUNCTION sw_mailbox_owner_same_org();

-- ---------------------------------------------------------------------------------------------
-- Arriving twice is not arriving

-- A sync that runs again over the same cursor — after a crash, a retry, a clock skew at the
-- provider — must not put the same message on the thread twice. The provider's own id is the
-- only thing that can say "this is the one you already have", which is what `external_id` has
-- been sitting there for.
CREATE UNIQUE INDEX messages_external_id_key
  ON messages (organization_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX conversations_external_id_key
  ON conversations (organization_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- The read the sweep makes

-- "Which mailboxes are due a sync", every pass, across every organization. The address key from
-- 0010 is keyed on the address and cannot answer it.
CREATE INDEX email_accounts_sync_idx
  ON email_accounts (organization_id, last_sync_at)
  WHERE status = 'connected' AND deleted_at IS NULL;
