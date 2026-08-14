-- 0016 · Step-up authentication for the decisions that cannot be undone
--
-- The AI-governance screen has claimed since Phase 3 that "publishing an agent, or granting
-- it high-risk capability, requires a second approver and step-up authentication". The
-- second approver is real — change control has enforced it since Phase 3. Step-up
-- authentication was never built. An interface that claims a control it does not have is
-- the most expensive kind of wrong: somebody reads it and stops worrying.
--
-- What step-up defends against is a session, not a password: a laptop left open, a stolen
-- cookie, a tab somebody else is sitting at. The person is asked to prove they are still
-- there, immediately before the irreversible thing, and the proof is stamped on the audit
-- row so an auditor can see it happened rather than take it on trust.

ALTER TABLE sessions
  -- When this session last re-proved its identity. Freshness is checked in code against
  -- STEP_UP_MAX_AGE_MS; storing an instant rather than a boolean means a step-up cannot
  -- be spent once and relied on for the rest of a fortnight-long session.
  ADD COLUMN stepped_up_at timestamptz,
  -- A stolen cookie must not become a password oracle. Failures are counted on the
  -- session and lock it out of stepping up; the session stays usable for everything it
  -- could already do, so a locked-out attacker gains nothing and a locked-out colleague
  -- loses nothing except the irreversible actions.
  ADD COLUMN step_up_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN step_up_locked_until timestamptz;

-- The audit row records the proof, not just the act. Taken from the request context rather
-- than passed as an argument, because an argument is one more thing a caller can forget,
-- and this is the field an auditor leans on.
--
-- It is stamped on *every* row the session writes, not only on the actions that required
-- it: the column records a fact about the request — was this person recently re-verified
-- when they did this — rather than an interpretation of which rule applied. NULL means the
-- session had not re-authenticated recently, which is the ordinary case.
ALTER TABLE audit_logs
  ADD COLUMN stepped_up_at timestamptz;

COMMENT ON COLUMN audit_logs.stepped_up_at IS
  'When the acting session last re-authenticated, at the moment of this action. NULL if it had not.';
