-- 0040 — A second factor.
--
-- `users.mfa_enabled` has existed since migration 0001 and nothing has ever written to it or
-- read it. There was no second factor anywhere in the product: a password opened a session,
-- and step-up — the gate in front of every irreversible action (§4.1) — re-asked for the same
-- password. So a stolen session plus a known password reached everything, and the boolean that
-- was supposed to say otherwise had never been true for anybody.
--
-- The column alone cannot carry it. A factor needs a secret to verify against, a record that
-- somebody proved they hold it, a way back in when they lose the phone, and a guard against the
-- same code being replayed inside its thirty-second window.

ALTER TABLE users
  -- Base32, RFC 4648. Never returned once enrolment is confirmed and never logged.
  ADD COLUMN mfa_secret text,
  -- When they proved a code from it. A secret nobody has proved is an enrolment in progress.
  ADD COLUMN mfa_confirmed_at timestamptz,
  -- The last time step accepted. A code is valid for thirty seconds, which is thirty seconds
  -- in which a shoulder-surfer can use it again; refusing to go backwards makes each code
  -- single-use without a cache to keep in step.
  ADD COLUMN mfa_last_counter bigint,
  -- Hashes only, and removed as they are used, so single use is the storage rather than a flag
  -- somebody has to remember to set.
  ADD COLUMN mfa_recovery_hashes text[] NOT NULL DEFAULT '{}';

/**
 * Nobody can be locked out by a half-finished enrolment.
 *
 * `mfa_enabled` on its own would let a row exist that demands a code against no secret, or
 * against a secret whose owner never proved they could read it. Either is an account nobody can
 * sign in to, which is a worse outcome than the one the factor prevents.
 */
ALTER TABLE users
  ADD CONSTRAINT users_mfa_needs_confirmed_secret
    CHECK (mfa_enabled = false OR (mfa_secret IS NOT NULL AND mfa_confirmed_at IS NOT NULL));

-- The half-authenticated state, made explicit rather than held in memory: the password was
-- accepted and the second factor has not been. A session in this state resolves to nothing, so
-- it reaches no screen and no API — and it can be revoked like any other.
ALTER TABLE sessions
  ADD COLUMN mfa_satisfied_at timestamptz;
