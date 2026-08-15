-- 0027 — Making the plan a company is on mean something.
--
-- `subscriptions` was seeded in migration 0001 with a tier, a seat count and an AI spend cap
-- and read by nothing. So was `plan_limits`, whose own comment in the config module says:
--
--     "These defaults seed the `plan_limits` table; the database is the source of truth at
--      runtime so limits can be changed without a deploy."
--
-- It is not. `checkSpendLimits` reads `DEFAULT_PLAN_LIMITS` — a compile-time constant — so
-- a limit could not be changed without a deploy, which is exactly what the comment promised.
--
-- The sharpest consequence is the refusal message. When an organization hits its cap the
-- agent stops and says *"An admin can raise the cap in Settings → Billing"*. There was no
-- such control on that screen. A refusal that sends somebody to a setting that does not
-- exist is worse than one that says no.
--
-- And the tier was stated twice — `organizations.plan_tier` and `subscriptions.tier` — with
-- nothing keeping them in step. The seed sets both to 'business'; nothing would have noticed
-- if they diverged.

-- One subscription per organization. Two is two answers to "what are we paying for", and
-- whichever the query happens to order first wins.
CREATE UNIQUE INDEX subscriptions_one_per_org
  ON subscriptions (organization_id)
  WHERE deleted_at IS NULL;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_status_known
    CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled')),
  -- A plan with no seats is not a plan.
  ADD CONSTRAINT subscriptions_seats_positive CHECK (seats_purchased > 0),
  ADD CONSTRAINT subscriptions_cap_not_negative
    CHECK (ai_spend_cap_cents IS NULL OR ai_spend_cap_cents >= 0);

-- Who last changed the organization's own caps, and why. Tightening a spend cap is a
-- decision somebody will be asked about when the agent stops.
ALTER TABLE subscriptions
  ADD COLUMN per_user_daily_cap_cents integer,
  ADD COLUMN caps_reason text,
  ADD COLUMN caps_set_by uuid REFERENCES users(id),
  ADD COLUMN caps_set_at timestamptz,
  ADD CONSTRAINT subscriptions_user_cap_not_negative
    CHECK (per_user_daily_cap_cents IS NULL OR per_user_daily_cap_cents >= 0);

/**
 * Keeps `organizations.plan_tier` in step with the subscription.
 *
 * The tier was stated in two places and reconciled by nobody. Rather than pick one and
 * rewrite every reader, the subscription becomes the source of truth and the database keeps
 * the older column true — the same shape as the jurisdiction history (ADR 0028): if two
 * places must agree, the agreement is not something application code should be trusted to
 * remember.
 */
CREATE OR REPLACE FUNCTION sw_sync_plan_tier() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NULL THEN
    UPDATE organizations SET plan_tier = NEW.tier, updated_at = now()
    WHERE id = NEW.organization_id AND plan_tier IS DISTINCT FROM NEW.tier;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER subscriptions_sync_plan_tier
  AFTER INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION sw_sync_plan_tier();

-- Bring any existing rows into step in the same migration, so the invariant holds from the
-- moment it is declared rather than from the next write.
UPDATE organizations o
SET plan_tier = s.tier
FROM subscriptions s
WHERE s.organization_id = o.id AND s.deleted_at IS NULL AND o.plan_tier IS DISTINCT FROM s.tier;
