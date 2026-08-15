-- 0030 — Somewhere for a reminder to arrive, and something behind the answer.
--
-- The nudge ladder (§29.2) has five rungs. Three chase the owner over chat; the fourth tells
-- whoever is waiting and the fifth escalates to the owner's manager, and both of those are
-- declared `channel: 'in_app'`. There is no in-app anything.
--
-- Every delivery also writes a `notifications` row. That table is written by four different
-- subsystems — the nudge worker, a workflow's notify node, task-dependency unblocking, and
-- the agent's "needs a decision" tool — and read by exactly two: retention, to delete it,
-- and erasure, to delete it. Nobody has ever seen one. When chat is not connected — the
-- default, since the whole product runs with no credentials — `postToChat` fails and the
-- code degrades to `channel = 'in_app'`, so *every* reminder the product sends lands
-- nowhere and is marked delivered.
--
-- And the answer meant nothing. `respondToNudge` has five actions — done, snooze,
-- renegotiate, reassign, blocked — under a comment reading "One action closes it". It wrote
-- the word to the row and nothing else: the task was untouched, and the due query does not
-- filter on `responded_at`, so answering rung one did not stop rungs two to five. You could
-- say "done" three times and still be escalated to your manager.

-- The five answers and no others. `response` was free text.
ALTER TABLE nudges
  ADD CONSTRAINT nudges_response_known
    CHECK (response IS NULL OR response IN ('done', 'snooze', 'renegotiate', 'reassign', 'blocked'));

-- What they said when they answered. `respondToNudge` accepts a note and drops it into an
-- activity summary; the row that carries the decision did not keep it.
ALTER TABLE nudges ADD COLUMN response_note text;

-- An answer is a moment: it has to be answered by somebody, and only after it arrived.
ALTER TABLE nudges
  ADD CONSTRAINT nudges_answered_after_delivery
    CHECK (responded_at IS NULL OR delivered_at IS NOT NULL);

-- The read this exists for: what one person has been asked, newest first.
CREATE INDEX nudges_recipient_delivered_idx
  ON nudges (organization_id, recipient_user_id, delivered_at DESC)
  WHERE deleted_at IS NULL;

-- The kinds of thing that write here. A type outside this set is a notification the screen
-- does not know how to label, which is how a row ends up blank on somebody's page.
-- `briefing.ready` is the one the §26.9 fan-out budget is measured against.
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN ('nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready'));

-- One notification per reminder. The delivery writes one; a retry that wrote a second would
-- put the same sentence on somebody's screen twice.
CREATE UNIQUE INDEX notifications_one_per_nudge
  ON notifications (entity_id)
  WHERE deleted_at IS NULL AND entity_type = 'nudge';

-- Everybody has preferences, whether or not a row was ever written for them. The briefing
-- scheduler reads this table with a LEFT JOIN and falls back to 8am — so a person who had
-- never opened the screen (nobody could) got the default and no way to say otherwise.
ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_hours_sane
    CHECK (briefing_hour BETWEEN 0 AND 23 AND end_of_day_hour BETWEEN 0 AND 23);

CREATE UNIQUE INDEX notification_preferences_one_per_person
  ON notification_preferences (organization_id, user_id)
  WHERE deleted_at IS NULL;
