-- 0028 — Reading the feedback people were already giving.
--
-- `insight_feedback` has been written since Phase 3 and read by nothing. The route that
-- writes it carries this comment:
--
--     "Dismissal reasons tune future thresholds per organization and per user (§9.2)."
--
-- Nothing tunes. The card asks *why* an insight was dismissed — not useful, wrong, already
-- handled, not my job — and the answer is discarded. People are being asked a question
-- whose answer goes nowhere, which is worse than not asking.
--
-- What did exist read a different signal. `mutedWatchers` auto-mutes a watcher whose
-- *dismissal rate* passes 70%, counting `insights.status = 'dismissed'` and nothing else.
-- That treats four different sentences as one:
--
--     "you were wrong"            — the watcher is producing false positives
--     "not useful"                — correct, and not worth surfacing
--     "already handled"           — the watcher was *right*; somebody had dealt with it
--     "not my job"                — right, and sent to the wrong person
--
-- Only the first two are evidence against a watcher. Muting on the other two throws away a
-- watcher that works.

-- The four sentences, and no others. A reason outside the set is feedback nobody can
-- interpret, and the route already restricts them — this stops anything else getting in.
ALTER TABLE insight_feedback
  ADD CONSTRAINT insight_feedback_reason_known
    CHECK (reason IS NULL OR reason IN ('not_useful', 'wrong', 'already_handled', 'not_my_job'));

-- "Not helpful" with no reason is a number with no meaning attached. The card always sends
-- one; this makes that a property of the data rather than a habit of one caller.
ALTER TABLE insight_feedback
  ADD CONSTRAINT insight_feedback_unhelpful_has_reason
    CHECK (helpful OR reason IS NOT NULL);

-- One vote per person per insight. Without this a single person can rate the same insight
-- a hundred times, and once feedback actually decides whether a watcher runs, that is one
-- person muting it on their own.
CREATE UNIQUE INDEX insight_feedback_one_per_person
  ON insight_feedback (insight_id, user_id)
  WHERE deleted_at IS NULL;

-- The read this exists for: group every insight of a watcher with its feedback.
CREATE INDEX insight_feedback_org_created_idx
  ON insight_feedback (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
