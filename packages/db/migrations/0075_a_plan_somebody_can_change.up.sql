-- 0075 — A plan somebody can change.
--
-- `subscriptions` has carried the plan a company is on since migration 0001, and ADR 0030 made
-- the runtime read it. What it never gained was a writer. Three columns tell the story:
--
--   • `tier` — written by the seed and by nothing else, so an organization is on whatever plan
--     the seed said, for ever;
--   • `seats_purchased` — the same, while `seatCheck` refuses the twenty-sixth invitation and
--     tells somebody to "buy more seats" at a screen with no such control;
--   • `status` and `period_end` — written by *nothing at all*, while `status` is read out onto
--     the billing screen beside the tier.
--
-- So the interface showed a plan, a seat count, a status and a renewal date, and the product
-- could not change any of them. That is the same shape as the refusal ADR 0030 fixed — a screen
-- naming a control that does not exist — one level up: there the cap had no editor, here the
-- plan the cap comes from has none.
--
-- `plan_limits` deliberately gains no writer. It has no `organization_id`: it is the price list,
-- one row per tier, shared by every tenant. A write from inside one organization would reprice
-- all of them, so the catalogue stays where it is and the tenant picks a row from it.

-- ---------------------------------------------------------------------------------------------
-- Who changed the plan, and why

-- The same shape the caps already use (`caps_reason`, `caps_set_by`, `caps_set_at`), for the same
-- reason: the agent stops when a limit is reached and somebody will ask who set it. A plan change
-- is the larger version of that question, because it also costs money.
ALTER TABLE subscriptions
  ADD COLUMN plan_changed_by uuid REFERENCES users(id),
  ADD COLUMN plan_changed_at timestamptz,
  ADD COLUMN plan_change_reason text,
  -- What the billing system called it. Superwork does not take payments; it records what the
  -- thing that does said, and shows it, so a bill can be traced back to the row that caused it.
  ADD COLUMN provider_reference text;

-- All three or none. A plan change with no reason is one nobody can review, and one with no
-- author is one nobody can ask about — and both are easier to prevent here than to detect later.
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_change_explained CHECK (
    (plan_changed_at IS NULL AND plan_changed_by IS NULL AND plan_change_reason IS NULL)
    OR (plan_changed_at IS NOT NULL AND plan_changed_by IS NOT NULL
        AND plan_change_reason IS NOT NULL AND length(btrim(plan_change_reason)) > 0)
  );

-- A period that ends before it starts is not a period. Nothing could have violated this before,
-- because nothing wrote either column; it is declared now that something does.
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_period_ends_after_start
    CHECK (period_end IS NULL OR period_end > period_start);

-- ---------------------------------------------------------------------------------------------
-- The renewal the worker sweeps for

-- One partial index, read by the sweep that asks "whose period has ended". Without it that is a
-- scan of every subscription in the installation once a pass.
CREATE INDEX subscriptions_renewal_due_idx
  ON subscriptions (period_end)
  WHERE deleted_at IS NULL AND period_end IS NOT NULL;

-- Existing rows have no period end, which means "never renews" — true until now, because nothing
-- could renew one. Giving them one turns the column into a date the screen can show and the sweep
-- can act on. A month from where the period already started, so the boundary is the one the row
-- has always claimed rather than a new one invented here.
UPDATE subscriptions
   SET period_end = period_start + interval '1 month'
 WHERE deleted_at IS NULL AND period_end IS NULL;

-- ---------------------------------------------------------------------------------------------
-- A renewal the owner hears about

-- The sweep renews a period, or records that the payment did not go through, and either is
-- something the person who signed for the plan has to be told. Carried forward and added to
-- rather than typed out from memory (ADR 0083's near-miss): reproducing an older list here would
-- narrow the constraint while looking like it widened it.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure', 'agent_digest',
      'approval_delegated', 'insight_returned', 'billing'
    ));
