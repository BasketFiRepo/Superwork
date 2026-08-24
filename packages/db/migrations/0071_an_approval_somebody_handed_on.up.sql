-- 0071 — An approval somebody handed on.
--
-- `approvals.delegated_to` has existed since migration 0005 and nothing has ever read or written
-- it. `ApprovalStatus` has carried `'delegated'` for just as long — a state the type system offers
-- and no code path can produce.
--
-- The module around it is the most carefully built thing here. `decideApproval` enforces the
-- policy's named role, refuses a rejection with no reason, checks edits against what the card
-- actually offered, and blocks self-approval on the *requester* rather than the assignee. The one
-- thing it cannot do is the ordinary thing: the person an approval is waiting on is away, and
-- there is no way to say so. `ApprovalView` already computes `hoursWaiting`, so the product knows
-- the card is ageing and offers nothing to do about it.

-- ---------------------------------------------------------------------------------------------
-- The status that was never the right model

-- `'delegated'` sits in the enum among `approved`, `rejected`, `expired` and `cancelled` — the
-- states in which nothing more is waiting. But an approval somebody handed on is still **pending**:
-- no decision has been made, and the queue that shows open work has to keep showing it. Any code
-- reading `status = 'pending'` to mean "still open" would silently drop delegated ones.
--
-- The column says whether a decision has been made. `delegated_to` says who it is waiting on.
-- Those are two different facts, and `'delegated'` is the second one written into the field that
-- holds the first — so it could never be set without making `status` unreliable. It was not
-- unreachable by accident; it was unreachable because reaching it would have broken something.
--
-- Postgres cannot drop a value from an enum, so the type is rebuilt. Nothing holds `'delegated'`
-- — nothing ever could — so the cast cannot lose a row. The two indexes on `status` are rebuilt
-- by the type change; neither is predicated on a particular value.
ALTER TABLE approvals ALTER COLUMN status DROP DEFAULT;
ALTER TYPE sw_approval_status RENAME TO sw_approval_status_old;
CREATE TYPE sw_approval_status AS ENUM (
  'pending', 'approved', 'approved_with_edits', 'rejected', 'expired', 'cancelled'
);
ALTER TABLE approvals
  ALTER COLUMN status TYPE sw_approval_status USING status::text::sw_approval_status;
ALTER TABLE approvals ALTER COLUMN status SET DEFAULT 'pending';
DROP TYPE sw_approval_status_old;

-- ---------------------------------------------------------------------------------------------
-- Who handed it on, to whom, and why

ALTER TABLE approvals
  ADD COLUMN delegated_by uuid REFERENCES users(id),
  ADD COLUMN delegated_at timestamptz,
  ADD COLUMN delegation_reason text;

-- The attribution pattern (ADR 0041), and here the reason is required rather than optional.
-- Handing your decision to somebody else is a statement about your own availability — "I am on
-- leave until the third" — not a judgement about them, which is why ADR 0081 refused a reason
-- field for absence and this one insists on it. An approval that moved with no explanation is
-- the shape of one that was moved to get it decided by somebody more agreeable.
--
-- `delegation_reason IS NOT NULL` is written out rather than left to `length()`, and it is the
-- whole constraint. A CHECK passes when its expression is TRUE **or NULL**, and
-- `length(btrim(NULL)) >= 8` is NULL — so the first draft of this accepted exactly the row it
-- was written to refuse: handed on, attributed, and no reason given. The test that writes that
-- row directly is what found it; every assertion made through the repository passed, because
-- the repository checks the reason itself before it ever reaches the database.
ALTER TABLE approvals
  ADD CONSTRAINT approvals_delegation_attributed CHECK (
    delegated_to IS NULL
    OR (
      delegated_by IS NOT NULL
      AND delegated_at IS NOT NULL
      AND delegation_reason IS NOT NULL
      AND length(btrim(delegation_reason)) >= 8
    )
  );

-- Handing it to yourself is not a hand-off.
ALTER TABLE approvals
  ADD CONSTRAINT approvals_delegation_moves CHECK (
    delegated_to IS NULL OR delegated_to IS DISTINCT FROM delegated_by
  );

-- **Never to the person who asked.** §11.3 says nothing is self-approved above the configured
-- threshold, and `decideApproval` enforces that against whoever actually decides. Delegation is
-- the route around it that nobody would notice: hand the card to the requester and the rule is
-- satisfied by the delegator's name while the requester clears their own request.
--
-- A CHECK rather than a trigger, because every column it needs is on the row. An agent's proposal
-- is deliberately not covered — the person did not propose it, their agent did, and a human
-- deciding what their own agent suggested is the entire design (§5.1).
ALTER TABLE approvals
  ADD CONSTRAINT approvals_delegation_not_to_the_requester CHECK (
    delegated_to IS NULL
    OR requested_by_actor_type <> 'user'
    OR requested_by_user_id IS NULL
    OR delegated_to IS DISTINCT FROM requested_by_user_id
  );

-- Both names have to belong to this organization. A foreign key to `users` reaches every tenant,
-- so on its own it says almost nothing — the rule `sw_agent_budget_setter_same_org` and
-- `sw_attendance_setter_same_org` already keep, for the third time.
CREATE OR REPLACE FUNCTION sw_approval_delegation_same_org() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships mm
    WHERE mm.user_id = NEW.delegated_to
      AND mm.organization_id = NEW.organization_id
      AND mm.deleted_at IS NULL AND mm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'an approval can only be handed to an active member of this organization';
  END IF;
  IF NEW.delegated_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memberships mm
    WHERE mm.user_id = NEW.delegated_by
      AND mm.organization_id = NEW.organization_id
      AND mm.deleted_at IS NULL AND mm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'an approval can only be handed on by an active member of this organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `IS NOT NULL` first on both, and it is load-bearing rather than tidy — the lesson ADR 0081
-- learned by shipping it wrong. Clearing a delegation is how one is taken back, and without the
-- guard that clear would fire the trigger with a null name, find no membership for nobody, and
-- refuse. A hand-off that could be made and never taken back is worse than none.
CREATE TRIGGER approvals_delegation_same_org_insert
  BEFORE INSERT ON approvals
  FOR EACH ROW WHEN (NEW.delegated_to IS NOT NULL)
  EXECUTE FUNCTION sw_approval_delegation_same_org();

CREATE TRIGGER approvals_delegation_same_org_update
  BEFORE UPDATE ON approvals
  FOR EACH ROW WHEN (
    NEW.delegated_to IS NOT NULL AND NEW.delegated_to IS DISTINCT FROM OLD.delegated_to
  )
  EXECUTE FUNCTION sw_approval_delegation_same_org();

-- ---------------------------------------------------------------------------------------------
-- The read the queue makes

-- "What has been handed to me", which `approvals_approver_idx` cannot serve: it is keyed on the
-- person a policy named, not on the person it was passed to.
CREATE INDEX approvals_delegated_idx
  ON approvals (organization_id, delegated_to, status)
  WHERE delegated_to IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Telling the person it now sits with

-- An approval handed to somebody who never hears about it is one that ages in a different queue,
-- so `delegateApproval` writes a notification — and `notifications_type_known` from 0030 is a
-- closed list, deliberately: a type nothing routes and no screen can name is a notification
-- nobody receives. Adding the type here is the same act as adding it to `NOTIFICATION_TYPES`,
-- which is what lets somebody set a preference about it before the first one arrives.
--
-- The list is carried forward from 0061 and added to, not rewritten. The first draft of this
-- reproduced 0030's original five values and appended one — which would have narrowed the set
-- from ten to six and refused every `disclosure` the transparency layer writes. Five migrations
-- have extended this constraint; a sixth that types it out from memory is how a control quietly
-- becomes a smaller one.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure', 'agent_digest',
      'approval_delegated'
    ));
