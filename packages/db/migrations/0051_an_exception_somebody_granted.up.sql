-- 0051 — An exception somebody granted.
--
-- `memberships.extra_permissions` is read on every request. `loadActor` selects it, hands it to
-- the policy engine, and `checkHumanPermissions` concatenates it with the role's own grants:
--
--     const grants = [...ROLE_PERMISSIONS[actor.role], ...actor.extraPermissions]
--
-- It is the documented way one person gets one capability their role does not carry — and
-- **nothing has ever written it**. The permission model has an escape hatch designed into the
-- function that decides every `can()` call, and no door to it. An administrator who needs to
-- give one person one extra capability has to change their role, which hands them everything
-- else that role carries.
--
-- The column is a bare `text[]`, which is why it could not be filled honestly: an exception
-- needs to say who granted it, why, and until when, and an array of strings has nowhere to put
-- any of that. A permanent, unattributed exception is not an exception; it is a quiet promotion.
--
-- So the grant becomes a row, and the array goes. `loadActor` reads live grants directly, which
-- is what makes an expiry exact — a permission that lingers until a sweep runs is a permission
-- that outlives its reason.

CREATE TABLE permission_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The person it is for. Not the membership, because a membership row is replaced when
  -- somebody's role changes and the exception should not silently survive that.
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- `resource:action:scope`, the same string the policy engine parses.
  permission      text NOT NULL,
  -- An exception is a decision about a person, so it names its decider and its reason. The
  -- length is the one legal holds use: enough that "because" alone will not pass.
  granted_by      uuid NOT NULL REFERENCES users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL,
  -- NULL means no end date, which is allowed and is called what it is on the screen.
  expires_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  revoked_at      timestamptz,
  revoke_reason   text,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT permission_grants_reason CHECK (length(btrim(reason)) >= 12),
  CONSTRAINT permission_grants_revocation CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
        AND revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) >= 4)
  )
);

/**
 * The shape the policy engine will accept, enforced where every writer meets it.
 *
 * `parsePermission` refuses the same three things in the application, with a sentence a person
 * can act on; this is the backstop for whoever writes a row another way. The engine's own
 * `catch { continue }` silently skips a malformed grant, which was harmless while nothing could
 * write one and would be a control that appears to work the moment somebody can.
 *
 * A `*` scope is refused because that is how "manager of one team" quietly becomes "manager of
 * everything" — the same reason the permission format has never allowed it.
 *
 * A `*` resource or action is refused *here* rather than only in the application, because an
 * exception is for one capability. `*:*:org` is not an exception; it is making somebody an owner
 * without saying so.
 */
CREATE OR REPLACE FUNCTION sw_grantable_permission(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT value ~ '^[a-z][a-z_]*:[a-z][a-z_]*:(own|team|department|org)$'
$$;

ALTER TABLE permission_grants
  ADD CONSTRAINT permission_grants_shape CHECK (sw_grantable_permission(permission));

-- One live grant of a permission per person: a second would be a duplicate with its own reason
-- and expiry, and nothing could say which of the two was in force.
CREATE UNIQUE INDEX permission_grants_one_live
  ON permission_grants (organization_id, user_id, permission)
  WHERE revoked_at IS NULL AND deleted_at IS NULL;

-- The lookup `loadActor` does on every request.
CREATE INDEX permission_grants_live_idx
  ON permission_grants (organization_id, user_id)
  WHERE revoked_at IS NULL AND deleted_at IS NULL;

SELECT sw_attach_touch('permission_grants'::regclass);

ALTER TABLE public.permission_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.permission_grants
  AS PERMISSIVE FOR ALL TO superwork_app
  USING (organization_id = sw_current_org())
  WITH CHECK (organization_id = sw_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.permission_grants TO superwork_app;

-- And the array goes. It has been read on every request since Phase 0 and written by nothing;
-- leaving it beside a table that now holds the same idea would be two places to disagree about
-- what somebody may do, which is the one thing a permission model cannot afford.
ALTER TABLE memberships DROP COLUMN extra_permissions;
