-- 0072 — An insight you can put off, and one you can finish.
--
-- The insight lifecycle is further built than it looks. `acknowledged`, `in_progress` and
-- `dismissed` all have controls on the card, and dismissal takes a reason that feeds watcher
-- quality. Two states do not, and one column has neither a writer nor a reader.
--
--   * `snoozed_until` has existed since 0006 and nothing has ever written it. `'snoozed'` has no
--     control, and nothing would bring an insight back if it did — a snooze that never ends is a
--     dismissal that lies about itself.
--   * `'resolved'` is in `FeedbackInput`'s union and on no button. So the only way to close an
--     insight the watcher got *right* is to dismiss it, and dismissal is a verdict on the
--     watcher: it feeds `watcherQuality` and can auto-mute one. The product has been asking
--     people to slander a watcher for being useful.
--   * `confidence` is written by nothing and read by nothing.

-- ---------------------------------------------------------------------------------------------
-- A number the product already answers better

-- `insights.confidence` is the watcher's own guess at whether it is right, defaulted to 0.8 and
-- never set by anything. The product already answers that question, and answers it from evidence:
-- `watcherQuality` measures what people actually did with a watcher's output, and mutes one that
-- keeps being wrong. A self-reported score beside a measured one is the same fact kept twice, and
-- the two would disagree in the direction that flatters the watcher.
ALTER TABLE insights DROP COLUMN confidence;

-- ---------------------------------------------------------------------------------------------
-- Not now

ALTER TABLE insights
  ADD COLUMN snoozed_by uuid REFERENCES users(id),
  ADD COLUMN snooze_reason text;

-- `status` and `snoozed_until` are two places holding one fact, and the database keeps them in
-- step rather than trusting every future caller to remember. An insight whose status says snoozed
-- with no date is one nothing will ever bring back; a date on an insight that is not snoozed is a
-- sweep waiting to move something somebody is working on.
--
-- Both sides are NOT NULL-safe: `status` is NOT NULL so the left is never NULL, and `IS NOT NULL`
-- never is either. That matters — ADR 0082 shipped a CHECK that passed on NULL and accepted the
-- exact row it was written to refuse.
ALTER TABLE insights
  ADD CONSTRAINT insights_snooze_has_an_end CHECK (
    (status = 'snoozed') = (snoozed_until IS NOT NULL)
  );

-- Putting something off hides it from everybody's screen, so somebody's name is on it. No reason
-- is required, deliberately, and that is the opposite call from ADR 0082's delegation.
--
-- Dismissal already demands one because it is a verdict on the watcher. A snooze is a verdict on
-- the timing, and demanding an explanation to say "not this week" is friction pointing at the
-- dismiss button — which would quietly corrupt the one signal watcher quality is built on.
ALTER TABLE insights
  ADD CONSTRAINT insights_snooze_attributed CHECK (
    snoozed_until IS NULL OR snoozed_by IS NOT NULL
  );

-- A snooze has to end in the future. A date already past is not a deferral, it is an insight the
-- next sweep will hand straight back — and more likely a wrong date nobody would notice, since
-- the card would look deferred until the sweep ran.
--
-- A trigger rather than a CHECK, for the reason `logInteraction` gives about the same shape: a
-- constraint cannot call `now()`, and a row that was legitimate when written must not turn
-- invalid as the clock passes it — which is exactly what a snooze does.
CREATE OR REPLACE FUNCTION sw_insight_snooze_ends_later() RETURNS trigger AS $$
BEGIN
  IF NEW.snoozed_until <= now() THEN
    RAISE EXCEPTION 'a snooze has to end in the future; that moment has already passed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Split across insert and update (ADR 0057), and with `IS NOT NULL` leading the update guard —
-- the lesson ADR 0081 learned by shipping it wrong. The sweep clears `snoozed_until` to bring an
-- insight back, and without that guard the clear would fire this and be refused against `now()`.
CREATE TRIGGER insights_snooze_ends_later_insert
  BEFORE INSERT ON insights
  FOR EACH ROW WHEN (NEW.snoozed_until IS NOT NULL)
  EXECUTE FUNCTION sw_insight_snooze_ends_later();

CREATE TRIGGER insights_snooze_ends_later_update
  BEFORE UPDATE ON insights
  FOR EACH ROW WHEN (
    NEW.snoozed_until IS NOT NULL AND NEW.snoozed_until IS DISTINCT FROM OLD.snoozed_until
  )
  EXECUTE FUNCTION sw_insight_snooze_ends_later();

-- And the name on it belongs to this organization. The fourth time this rule is written, after
-- `sw_agent_budget_setter_same_org`, `sw_attendance_setter_same_org` and
-- `sw_approval_delegation_same_org`: a foreign key to `users` reaches every tenant.
CREATE OR REPLACE FUNCTION sw_insight_snoozer_same_org() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships mm
    WHERE mm.user_id = NEW.snoozed_by
      AND mm.organization_id = NEW.organization_id
      AND mm.deleted_at IS NULL AND mm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'an insight can only be put off by an active member of this organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER insights_snoozer_same_org_insert
  BEFORE INSERT ON insights
  FOR EACH ROW WHEN (NEW.snoozed_by IS NOT NULL)
  EXECUTE FUNCTION sw_insight_snoozer_same_org();

CREATE TRIGGER insights_snoozer_same_org_update
  BEFORE UPDATE ON insights
  FOR EACH ROW WHEN (
    NEW.snoozed_by IS NOT NULL AND NEW.snoozed_by IS DISTINCT FROM OLD.snoozed_by
  )
  EXECUTE FUNCTION sw_insight_snoozer_same_org();

-- ---------------------------------------------------------------------------------------------
-- The read the sweep makes

-- "Which snoozes are up", every minute, across every organization. `insights_org_status_idx` is
-- keyed on severity and creation time and cannot answer it.
CREATE INDEX insights_snoozed_until_idx
  ON insights (organization_id, snoozed_until)
  WHERE status = 'snoozed' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Telling whoever put it off

-- Carried forward and added to, not typed out from memory — ADR 0082's near-miss, where a first
-- draft reproduced an older list and would have narrowed the constraint while appearing to widen
-- it. An insight that comes back silently is indistinguishable from one that was dismissed.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure', 'agent_digest',
      'approval_delegated', 'insight_returned'
    ));
