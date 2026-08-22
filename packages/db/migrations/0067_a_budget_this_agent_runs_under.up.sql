-- 0067 — A budget this agent runs under.
--
-- `agents.budget` has been a `jsonb NOT NULL DEFAULT '{}'` since migration 0006. `SELECT_AGENT`
-- reads it into every persona the product builds, and nothing consults it: not the runtime, not
-- Agent Studio, not the governance screen. The seed is the only thing that has ever written one.
--
-- The brake it belongs to is already built and already works. `packages/agent/src/budget.ts`
-- stops a run on steps, tool calls, spend, wall clock and tokens, halts honestly rather than
-- degrading, and sets the run to `budget_exceeded`. What it stops on is `DEFAULT_RUN_BUDGET` — a
-- product constant — because `newBudget()` is called with no overrides on every path there is.
--
-- So every agent in every organization runs under the same numbers, and the column that exists to
-- say otherwise is read into a view and dropped. `RunBudget`'s own comment has said what should
-- happen since it was written:
--
--     Default per-run agent budget (§5.5). Organizations may tighten but not exceed plan caps.
--
-- This is that sentence, built. The arrangement is the one `subscriptions` has against
-- `plan_limits` and `allowed_regions` has against `provisioned_regions`: a ceiling nobody in the
-- tenant can raise, and beneath it a tightening the organization sets on itself, with its reason
-- and the person who set it recorded beside it.

-- Who tightened it, when, and why (ADR 0044 onward). A limit that stops an agent mid-run is
-- exactly the setting somebody is asked about the following week.
ALTER TABLE agents
  ADD COLUMN budget_set_by uuid REFERENCES users(id),
  ADD COLUMN budget_set_at timestamptz,
  ADD COLUMN budget_reason text,
  ADD CONSTRAINT agents_budget_attributed
    CHECK (
      (budget_set_by IS NULL) = (budget_set_at IS NULL)
      AND (budget_set_at IS NULL) = (budget_reason IS NULL)
    );

/**
 * What a per-agent budget is allowed to say.
 *
 * A trigger rather than a CHECK because the rules are about the *shape* of a jsonb document —
 * which keys it may carry — and a CHECK cannot run the subquery that needs.
 *
 * Three rules:
 *
 *   * **Only keys the runtime enforces.** `checkBudget` reads steps, tool calls, spend and wall
 *     clock; tokens and parallelism are the model layer's business and not an operator's dial. A
 *     key nobody reads would be a setting that silently does nothing, which is the failure this
 *     whole line of work exists to end.
 *   * **Whole positive numbers.** A budget of zero is not a tightening, it is an agent that
 *     cannot take one step, and it would be indistinguishable on screen from a careful limit.
 *   * **Never above the product's default.** An organization may tighten, never exceed — the
 *     same sentence `setCaps` says about spend, and for the same reason: the ceiling is a
 *     commercial and safety decision rather than a setting.
 *
 * The ceiling numbers appear here as literals, which makes this the second place
 * `DEFAULT_RUN_BUDGET` lives. That is a real cost and it is taken deliberately: the alternative
 * is a rule only application code keeps, and the whole argument of ADRs 0072 and 0074 is that
 * such a rule is one anything holding a connection can break. `tests/unit/agent-budget.test.ts`
 * reads this file and refuses it the moment its numbers stop matching the constant — the same
 * arrangement `schema-manifest.ts` has with the migrations directory.
 */
CREATE OR REPLACE FUNCTION sw_agent_budget_within_default() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  key text;
  value jsonb;
  ceiling jsonb := '{
    "maxSteps": 24,
    "maxToolCalls": 40,
    "maxCostCents": 50,
    "maxWallClockMs": 120000
  }'::jsonb;
BEGIN
  FOR key, value IN SELECT * FROM jsonb_each(NEW.budget) LOOP
    IF NOT (ceiling ? key) THEN
      RAISE EXCEPTION 'a run budget has no setting called %', key
        USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(value) <> 'number' OR (value::text)::numeric <> trunc((value::text)::numeric) THEN
      RAISE EXCEPTION '% has to be a whole number', key
        USING ERRCODE = 'check_violation';
    END IF;
    IF (value::text)::numeric < 1 THEN
      RAISE EXCEPTION '% has to be at least 1 — an agent that may do nothing is switched off, not limited', key
        USING ERRCODE = 'check_violation';
    END IF;
    IF (value::text)::numeric > (ceiling->>key)::numeric THEN
      RAISE EXCEPTION '% cannot be raised above the product limit of %', key, ceiling->>key
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- The two-trigger split 0057 introduced: a guard narrowed to the arriving value, so an edit to
-- some other column on the row is not refused for a budget it never touched.
CREATE TRIGGER agents_budget_within_default_insert
  BEFORE INSERT ON agents
  FOR EACH ROW WHEN (NEW.budget <> '{}'::jsonb)
  EXECUTE FUNCTION sw_agent_budget_within_default();

CREATE TRIGGER agents_budget_within_default_update
  BEFORE UPDATE ON agents
  FOR EACH ROW WHEN (NEW.budget IS DISTINCT FROM OLD.budget)
  EXECUTE FUNCTION sw_agent_budget_within_default();

/**
 * And the person who set it is a colleague.
 *
 * The same rule `sw_agent_recertifier_same_org` keeps about the person who last vouched for an
 * agent, for the same reason: a name on a control is worth nothing if it can be somebody the
 * organization has never heard of.
 */
CREATE OR REPLACE FUNCTION sw_agent_budget_setter_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = NEW.budget_set_by AND m.organization_id = NEW.organization_id
      AND m.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'an agent budget can only be set by a member of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agents_budget_setter_same_org_insert
  BEFORE INSERT ON agents
  FOR EACH ROW WHEN (NEW.budget_set_by IS NOT NULL)
  EXECUTE FUNCTION sw_agent_budget_setter_same_org();

CREATE TRIGGER agents_budget_setter_same_org_update
  BEFORE UPDATE ON agents
  FOR EACH ROW WHEN (NEW.budget_set_by IS NOT NULL AND NEW.budget_set_by IS DISTINCT FROM OLD.budget_set_by)
  EXECUTE FUNCTION sw_agent_budget_setter_same_org();
