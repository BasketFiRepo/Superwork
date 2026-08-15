-- 0032 — Two ceilings an admin could see and not set.
--
-- `monitoring_policies` holds the organization's own limits on how hard the system may chase
-- its people: the nudge budget per person per day, and the no-surprises window a person gets
-- to answer before anything about them goes past them. The screen displays both. Nothing has
-- ever written the row but the seed, so neither could be changed without editing the
-- database — and the review window is enforced from the *jurisdiction profile constant*,
-- never from this row, so an organization that set itself a longer window than its
-- jurisdiction requires would have seen its own number on the screen and had the shorter one
-- applied.
--
-- `agent_permissions` is the organization-wide ceiling on what any agent may do. It has two
-- hollow columns. `effect` accepts 'deny' and `asAgent` filters for 'allow' and drops the
-- rest, so a deny row has never denied anything. `max_sensitivity` is on every row and is
-- never read, so the clearance ceiling it describes does not exist.
--
-- And the agent's own refusal says: "An admin can add it in Settings → AI Governance."
-- That screen listed the grants and had no control on it. A refusal that sends somebody to a
-- setting which does not exist is worse than a plain no — the same defect as the spend cap
-- in ADR 0030.

-- The profiles that exist. `jurisdiction_profile` was free text on a row that decides how
-- §29 behaves.
ALTER TABLE monitoring_policies
  ADD CONSTRAINT monitoring_profile_known
    CHECK (jurisdiction_profile IN ('works_council', 'gdpr', 'standard', 'strict'));

-- Numbers that mean something. A budget of zero is a legitimate answer — "do not chase my
-- people at all" — but a negative one is not, and a review window longer than a week makes
-- the escalation path unreachable rather than careful.
ALTER TABLE monitoring_policies
  ADD CONSTRAINT monitoring_budget_sane CHECK (nudge_budget_per_person_per_day BETWEEN 0 AND 20),
  ADD CONSTRAINT monitoring_window_sane CHECK (no_surprises_review_hours BETWEEN 1 AND 168);

-- Who set these, and why. Somebody asked to explain why the company chases people twice a
-- day rather than three times should not have to read a migration to answer.
ALTER TABLE monitoring_policies
  ADD COLUMN reason text,
  ADD COLUMN set_by uuid REFERENCES users(id),
  ADD COLUMN set_at timestamptz;

-- Both effects, spelled the same way every time.
ALTER TABLE agent_permissions
  ADD CONSTRAINT agent_permissions_effect_known CHECK (effect IN ('allow', 'deny'));

-- Why the grant exists. A ceiling on what an agent may do is a decision somebody made about
-- risk, and a bare row of tool patterns cannot say what it was.
ALTER TABLE agent_permissions ADD COLUMN reason text;

-- The column is called `tool_pattern` and the matcher reads it as a *permission* pattern:
-- `matchesGrant` splits on ':' and compares the halves to the resource and the verb. The
-- seed wrote tool names — `draft_email`, `create_task` — which parse as a resource called
-- "draft_email" and therefore match nothing at all. The only row that has ever covered
-- anything is the `*`, and because a non-empty grant list means "only what is listed", those
-- four lines have been decorative since Phase 0.
--
-- They are rewritten here rather than left to look like policy. No CHECK is added: a row
-- that matches nothing is now visible on a screen where somebody can fix it, and a
-- constraint that rejected an existing row would take the whole migration down with it.
UPDATE agent_permissions SET tool_pattern = 'email:draft'  WHERE tool_pattern = 'draft_email';
UPDATE agent_permissions SET tool_pattern = 'task:create'  WHERE tool_pattern = 'create_task';
UPDATE agent_permissions SET tool_pattern = 'task:update'  WHERE tool_pattern = 'update_task';
UPDATE agent_permissions SET tool_pattern = 'contact:update' WHERE tool_pattern = 'link_entities';

-- One row per capability, pattern and scope. Two rows saying different things about the same
-- pattern is a ceiling nobody can predict — and with deny now beating allow, a duplicate is
-- the difference between a grant working and not.
CREATE UNIQUE INDEX agent_permissions_one_per_scope
  ON agent_permissions (organization_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid), capability, tool_pattern)
  WHERE deleted_at IS NULL;

/**
 * A department-scoped grant names a department of the same organization.
 *
 * The column is a plain uuid with no foreign key, and `asAgent` matches it against the
 * actor's departments — so a row pointing at another tenant's department would silently
 * widen or narrow the wrong people's agents.
 */
CREATE OR REPLACE FUNCTION sw_agent_permission_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.department_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM departments
    WHERE id = NEW.department_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a grant must name a department of the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_permissions_same_org
  BEFORE INSERT OR UPDATE ON agent_permissions
  FOR EACH ROW EXECUTE FUNCTION sw_agent_permission_same_org();

-- The read `asAgent` does on every request that involves an agent.
CREATE INDEX agent_permissions_org_department_idx
  ON agent_permissions (organization_id, department_id)
  WHERE deleted_at IS NULL;
