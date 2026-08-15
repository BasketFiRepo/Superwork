-- 0026 — Making an invitation usable.
--
-- `invitations` was created in migration 0001 and never read or written. The consequence is
-- the largest single gap in the product: there has been **no way to add a person to an
-- organization** except by running the seed or by connecting a directory sync. A product
-- whose first act is "invite your colleagues" could not do it.
--
-- The table was close. It already had `token_hash`, `expires_at` and `accepted_at`, which is
-- the right shape — an invitation is a credential, stored hashed and shown once. What it
-- lacked was everything about the invitation's *life*: who it was for, why, who withdrew it,
-- and who it eventually became.

-- An invitation is looked up by its token on a page nobody is signed in to, so this is the
-- one index that matters and it did not exist.
CREATE UNIQUE INDEX invitations_token_idx ON invitations (token_hash) WHERE deleted_at IS NULL;

ALTER TABLE invitations
  -- Withdrawn before it was used. Kept rather than deleted: "who invited that contractor
  -- and who called it off" is a question an access review asks.
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES users(id),
  ADD COLUMN revoked_reason text,
  -- Which user the invitation became. Without it, an accepted invitation and the membership
  -- it created are two rows nothing connects.
  ADD COLUMN accepted_user_id uuid REFERENCES users(id),
  -- Why this person is being given access, stated when the invitation is written rather
  -- than reconstructed from an audit log a year later.
  ADD COLUMN reason text,
  ADD COLUMN invited_by uuid REFERENCES users(id);

-- One live invitation per address. Two outstanding invitations for the same person is two
-- different roles racing each other, and whichever link they happen to open wins.
CREATE UNIQUE INDEX invitations_pending_email
  ON invitations (organization_id, lower(email))
  WHERE deleted_at IS NULL AND accepted_at IS NULL AND revoked_at IS NULL;

-- An invitation that never expires is a credential with no end date, so one cannot be
-- *created* already lapsed. A CHECK would have been the obvious way and is the wrong one:
-- it fires on UPDATE too, which blocks expiring an invitation early — a softer withdrawal
-- that an administrator should be able to make. Insert-only, as a trigger.
CREATE OR REPLACE FUNCTION sw_invitation_expiry_ahead() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expires_at <= now() THEN
    RAISE EXCEPTION 'an invitation cannot be created already expired'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER invitations_expiry_ahead
  BEFORE INSERT ON invitations
  FOR EACH ROW EXECUTE FUNCTION sw_invitation_expiry_ahead();

-- An accepted invitation cannot also be revoked. The two are exclusive outcomes and a row
-- carrying both cannot be reported on honestly.
ALTER TABLE invitations
  ADD CONSTRAINT invitations_one_outcome CHECK (accepted_at IS NULL OR revoked_at IS NULL);

-- An accepted invitation names the user it became.
ALTER TABLE invitations
  ADD CONSTRAINT invitations_accepted_has_user
    CHECK (accepted_at IS NULL OR accepted_user_id IS NOT NULL);

CREATE INDEX invitations_org_idx ON invitations (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
