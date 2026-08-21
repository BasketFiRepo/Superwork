-- 0062 — A next step that is already true.
--
-- `contacts.next_step` and `contacts.next_step_at` were added in migration 0010 and nothing has
-- ever written either. `SELECT_CONTACT` reads both into every `ContactView`; the contacts table
-- on the company page shows **Name · Email · Last touch** and never the forward-looking half.
-- The screen answers "when did we last speak to this person" and drops the answer to "what
-- happens next with them" on the floor.
--
-- The obvious repair is to make them settable: a text box and a date on a contact, the way every
-- CRM has one. That is the wrong repair here, and the reason is the rule this codebase keeps
-- writing ADRs about — when two places hold the same fact they disagree.
--
-- This product already has three places that mean "something is owed and here is when":
--
--   * **commitments**, which carry a counterparty contact, a due date and an obligation, and
--     which somebody has accepted;
--   * **follow-ups**, on a thread or an account;
--   * **tasks**, with dates and owners.
--
-- A free-text next step on the contact would be a fourth, reconciled with none of them. Somebody
-- would type "call Ingrid Thursday" while the commitment ledger says Wednesday and a follow-up
-- says next week, and the CRM screen would show whichever of the three nobody had got round to
-- correcting.
--
-- The product already knows what is next with a person. A commitment they are the counterparty
-- to, and a meeting they are attending, are both contact-scoped, both dated, and both already
-- true — so the next step is a *read*, computed where it is shown, and there is nothing to keep
-- in step because there is no second copy. What was missing was never a place to write; it was
-- the query.
--
-- Company-level follow-ups are deliberately not folded in: a follow-up on the Halden account is
-- about the account, and showing it against all four people at Halden would be four rows saying
-- the same thing about none of them.

-- Empty in every row of every database, because nothing has ever written them — which is the one
-- case where dropping a column loses nothing. The down script re-adds them, and they come back
-- exactly as they were: present, and holding nothing.
ALTER TABLE contacts
  DROP COLUMN next_step,
  DROP COLUMN next_step_at;

-- "What is next with this person", which is the read the contacts table now makes per row. Two
-- indexes because the answer comes from two places: a promise they are the counterparty to, and
-- a meeting they are coming to.
CREATE INDEX commitments_counterparty_due_idx
  ON commitments (organization_id, counterparty_contact_id, due_at)
  WHERE deleted_at IS NULL AND counterparty_contact_id IS NOT NULL;

-- The existing participant index is keyed on the meeting, which answers "who is coming to this".
-- The read here goes the other way.
CREATE INDEX meeting_participants_contact_idx
  ON meeting_participants (organization_id, contact_id)
  WHERE deleted_at IS NULL AND contact_id IS NOT NULL;
