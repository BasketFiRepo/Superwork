-- 0043 — When you are written to.
--
-- `notification_preferences` has held three columns since migration 0010 that nothing has ever
-- honoured:
--
--   **`quiet_hours`** — defaulted to 18:30–08:30 for everybody and consulted by nothing, so a
--   task comment at half past eleven at night reached the person immediately, and the reminder
--   ladder — which knows about weekends and public holidays (ADR 0039) — knew nothing about
--   the evening.
--
--   **`channel_defaults`** and **`per_type`** — the shape of "which of these do I want to see
--   the moment they happen, and which can wait for the morning". Every notification in the
--   product was written with `delivery` hard-coded at the call site, seven call sites deep, and
--   the person it was addressed to had no say at all.
--
-- The screen said so honestly — the three fields were rendered read-only under a "Coming soon"
-- chip. This migration is the schema half of removing that chip.
--
-- Two rules are enforced here rather than in one code path, because the interesting values are
-- inside jsonb and any writer could put anything there:
--
--   1. a delivery is `immediate`, `digest` or `none` — nothing else is a delivery;
--   2. quiet hours are two wall-clock times, and cannot cover the whole day.

/**
 * Every value in a delivery map is a delivery this product understands.
 *
 * IMMUTABLE and free of subqueries so a CHECK constraint can call it: the constraint is the
 * point, since `per_type` accepts arbitrary keys and a typo would otherwise be stored and then
 * silently ignored at read time — a preference that appears to be saved and does nothing.
 */
CREATE OR REPLACE FUNCTION sw_delivery_map_ok(map jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(map) = 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each_text(map) AS entry(key, value)
       WHERE value NOT IN ('immediate', 'digest', 'none')
     )
$$;

/**
 * Quiet hours are two wall-clock times, and leave at least eight hours a day open.
 *
 * A window is allowed to wrap midnight — that is the ordinary case. It is not allowed to cover
 * the day: "never write to me" is not a preference this product offers, because colleagues rely
 * on reaching each other through it, and the honest form of that wish is turning types down to
 * `none` one at a time, in the open.
 */
CREATE OR REPLACE FUNCTION sw_quiet_hours_ok(quiet jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(quiet) = 'object'
     AND quiet ? 'start' AND quiet ? 'end'
     AND quiet->>'start' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND quiet->>'end'   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND (
       -- Minutes of quiet, whichever way round the window is written.
       CASE
         WHEN quiet->>'start' = quiet->>'end' THEN 1440
         ELSE ((
           (split_part(quiet->>'end', ':', 1)::int * 60 + split_part(quiet->>'end', ':', 2)::int)
           - (split_part(quiet->>'start', ':', 1)::int * 60 + split_part(quiet->>'start', ':', 2)::int)
           + 1440
         ) % 1440)
       END
     ) <= 960
$$;

ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_channels_known
    CHECK (sw_delivery_map_ok(channel_defaults)),
  ADD CONSTRAINT notification_preferences_per_type_known
    CHECK (sw_delivery_map_ok(per_type)),
  ADD CONSTRAINT notification_preferences_quiet_hours_valid
    CHECK (sw_quiet_hours_ok(quiet_hours));

ALTER TABLE notifications
  ADD CONSTRAINT notifications_delivery_known
    CHECK (delivery IN ('immediate', 'digest', 'none'));

-- `disclosure` joins the known types: the notice that something about somebody reached
-- somebody else. It was recorded on the subject's own record and never sent to them, so the
-- guarantee — nothing about you reaches your manager without you knowing — relied on the
-- person thinking to go and look (ADR 0047).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_known;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_known
    CHECK (type IN (
      'nudge', 'workflow', 'task_unblocked', 'agent_needs_input', 'briefing.ready',
      'follow_up', 'mention', 'task_changed', 'disclosure'
    ));

-- What is waiting for somebody and not yet visible: the read the badge and the briefing both
-- make. `deliver_after` has been on the table since 0005, defaulted to now(), and written by
-- nothing — it is the mechanism a held notification needs, and it is why holding one loses
-- nothing: the row exists from the moment it is written, and becomes visible when the window
-- opens.
CREATE INDEX notifications_pending_idx
  ON notifications (organization_id, user_id, deliver_after)
  WHERE deleted_at IS NULL AND read_at IS NULL;
