-- 0037 — What the model was asked, what it said, and what that cost.
--
-- `agent_messages` was created in migration 0003 with `role`, `content`, `task_class`,
-- `model`, `tokens_in`, `tokens_out`, `cost_cents`, `latency_ms` and `simulated`, and nothing
-- has ever written a row. Cost was recorded only as a running total on `agent_runs`, so the
-- AI ledger could say a run cost four cents and could not say which step, which model, or how
-- long any of it took.
--
-- Two writers already existed for that number and they had drifted:
--
--   `addUsage` incremented the run's totals on every model call, and `usage_records` was
--   written separately at *some* of the same call sites — three of four in the nervous
--   system, so one model call's spend never reached metering at all.
--
--   Worse, both the ask and act paths also wrote a `unit = 'agent_run'` usage record
--   carrying the run's *whole* cost, on top of the per-call rows. `spendSnapshot` sums
--   `cost_cents` across every unit, so an ask run was counted roughly twice: month-to-date
--   AI spend was inflated, and the §19.2 spend cap tripped at about half the real figure.
--
-- The fix is the pattern the rest of this schema already uses: one writer, and the agreement
-- belongs to the database.

ALTER TABLE agent_messages
  ADD CONSTRAINT agent_messages_role_known CHECK (role IN ('user', 'assistant', 'system')),
  ADD CONSTRAINT agent_messages_content_present CHECK (length(btrim(content)) > 0),
  ADD CONSTRAINT agent_messages_counts_sane
    CHECK (tokens_in >= 0 AND tokens_out >= 0 AND cost_cents >= 0 AND (latency_ms IS NULL OR latency_ms >= 0));

-- "Where did this month's model spend go", which nothing could answer.
CREATE INDEX agent_messages_model_idx
  ON agent_messages (organization_id, created_at DESC, model)
  WHERE deleted_at IS NULL;

/**
 * A message and its run belong to the same organization.
 *
 * `run_id` has a foreign key and nothing ties it to `organization_id`, and the roll-up below
 * writes to whichever run the row names — so a row crossing tenants would move one company's
 * model spend onto another's bill. Same reasoning as 0034 and 0035.
 */
CREATE OR REPLACE FUNCTION sw_agent_message_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_runs
    WHERE id = NEW.run_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'an agent message must belong to a run in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_messages_same_org
  BEFORE INSERT OR UPDATE ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION sw_agent_message_same_org();

/**
 * The run's totals are the sum of its messages.
 *
 * They were kept by application code incrementing three columns on every model call, which is
 * exactly the arrangement ADR 0028 named: when two places must agree, the agreement is not
 * something application code should be trusted to remember. Recomputed rather than
 * incremented, so a deleted or corrected message leaves the total right rather than leaving
 * it drifted by the amount of the correction.
 */
CREATE OR REPLACE FUNCTION sw_agent_run_usage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid := coalesce(NEW.run_id, OLD.run_id);
BEGIN
  UPDATE agent_runs r
  SET tokens_in = totals.tokens_in,
      tokens_out = totals.tokens_out,
      cost_cents = totals.cost_cents
  FROM (
    SELECT coalesce(sum(m.tokens_in), 0)::integer AS tokens_in,
           coalesce(sum(m.tokens_out), 0)::integer AS tokens_out,
           coalesce(sum(m.cost_cents), 0)::numeric(12,4) AS cost_cents
    FROM agent_messages m
    WHERE m.run_id = target AND m.deleted_at IS NULL
  ) AS totals
  WHERE r.id = target;
  RETURN NULL;
END
$$;

CREATE TRIGGER agent_messages_roll_up
  AFTER INSERT OR UPDATE OR DELETE ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION sw_agent_run_usage();
