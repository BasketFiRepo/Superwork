import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { DEFAULT_FLAGS, FEATURE_FLAGS, type FeatureFlag } from '@superwork/config'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'

/**
 * Feature flags (§2.3).
 *
 * `feature_flag_overrides` is the odd one out among the tables nothing writes to, because
 * the read path was finished. `apps/web/src/lib/session.ts` loads this table on every
 * request, separates the organization-wide rows from the per-user ones and layers them over
 * `DEFAULT_FLAGS`. That code has run on every page load since Phase 0 and has never found a
 * row, so every organization has had identical features and no administrator could change
 * one.
 *
 * The resolution order is default → organization → person, and it is worth being explicit
 * about what that means: an organization turning something off does *not* stop a person who
 * has an override turning it back on for themselves. That is correct for a preference like
 * density and wrong for a capability, which is why the two kinds are labelled differently
 * here — a flag that governs what a tenant may do belongs in policy or a plan limit, not in
 * a switch a person can flip for themselves.
 */

export type FlagScope = 'organization' | 'user'

export interface FlagState {
  flag: FeatureFlag
  label: string
  /** What this actually changes today. Empty when it currently controls nothing. */
  controls: string
  defaultValue: boolean
  organizationValue: boolean | null
  userValue: boolean | null
  /** The value in force for this actor, after both layers. */
  effective: boolean
  source: 'default' | 'organization' | 'you'
  reason: string | null
  setByName: string | null
}

/**
 * What each flag does, in the words of somebody deciding whether to turn it off — and
 * honestly empty where the answer is "nothing yet". A switch that changes nothing is worse
 * than an absent one, because somebody will use it and believe it worked.
 */
const FLAG_META: Record<FeatureFlag, { label: string; controls: string }> = {
  inbox: { label: 'Inbox', controls: 'The Inbox screen and its navigation entry.' },
  meetings: { label: 'Meetings', controls: 'The Meetings screen and its navigation entry.' },
  crm: { label: 'Companies', controls: 'The Companies screen and its navigation entry.' },
  workflows: { label: 'Workflows', controls: 'The Workflows screen and its navigation entry.' },
  insights: { label: 'Insights', controls: 'The Insights screen and its navigation entry.' },
  compact_density: {
    label: 'Compact rows',
    controls: 'Row height throughout the interface. A personal preference — set it on yourself.',
  },
  reports: { label: 'Reports', controls: '' },
  autopilot: { label: 'Autopilot', controls: '' },
  chat_presence: { label: 'Chat presence', controls: '' },
  public_api: { label: 'Public API', controls: '' },
}

/**
 * Reading takes no permission.
 *
 * The session already resolves every one of these for every signed-in person on every
 * request — that is what decides which navigation items they see. Requiring `settings:read`
 * here would mean a member could not discover why a screen is missing, or set their own row
 * height, while the same values were being computed for them a layer down. The organization
 * layer is what needs a permission, and that is on the write path.
 */

/** Turning a feature off for everybody is an administrator's decision. */
function guardWrite(ctx: TenantContext, actor: Actor, scope: FlagScope): void {
  if (scope === 'user') return
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function flagStates(ctx: TenantContext, actor: Actor): Promise<FlagState[]> {
  const rows = await ctx.sql<
    { flag: string; enabled: boolean; user_id: string | null; reason: string | null; set_by_name: string | null }[]
  >`
    SELECT f.flag, f.enabled, f.user_id, f.reason, u.name AS set_by_name
    FROM feature_flag_overrides f
    LEFT JOIN users u ON u.id = f.set_by
    WHERE f.organization_id = ${ctx.organizationId} AND f.deleted_at IS NULL
      AND (f.user_id IS NULL OR f.user_id = ${actor.userId})`

  return FEATURE_FLAGS.map((flag) => {
    const org = rows.find((row) => row.flag === flag && row.user_id === null)
    const mine = rows.find((row) => row.flag === flag && row.user_id !== null)
    const effective = mine?.enabled ?? org?.enabled ?? DEFAULT_FLAGS[flag]
    return {
      flag,
      label: FLAG_META[flag].label,
      controls: FLAG_META[flag].controls,
      defaultValue: DEFAULT_FLAGS[flag],
      organizationValue: org?.enabled ?? null,
      userValue: mine?.enabled ?? null,
      effective,
      source: mine ? 'you' : org ? 'organization' : 'default',
      reason: mine?.reason ?? org?.reason ?? null,
      setByName: mine ? null : (org?.set_by_name ?? null),
    }
  })
}

export async function setFlag(
  ctx: TenantContext,
  actor: Actor,
  input: { flag: string; enabled: boolean; scope: FlagScope; reason?: string },
): Promise<FlagState[]> {
  guardWrite(ctx, actor, input.scope)

  // The database refuses an unknown name too (0023). This is here so the caller gets a
  // sentence rather than a constraint violation.
  if (!(FEATURE_FLAGS as readonly string[]).includes(input.flag)) {
    throw new ValidationError(
      `"${input.flag}" is not a feature. An override for a name nothing reads would sit there for ever ` +
        'looking as though it did something.',
    )
  }
  const flag = input.flag as FeatureFlag
  if (input.scope === 'organization' && (input.reason?.trim().length ?? 0) < 4) {
    throw new ValidationError('Say why. A tenant that differs from every other one needs a reason on the row.')
  }

  await ctx.sql`
    INSERT INTO feature_flag_overrides (organization_id, user_id, flag, enabled, reason, set_by, created_by)
    VALUES (
      ${ctx.organizationId}, ${input.scope === 'user' ? actor.userId : null}, ${flag}, ${input.enabled},
      ${input.reason?.trim() || null}, ${actor.userId}, ${ctx.userId}
    )
    ON CONFLICT (organization_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), flag)
      WHERE deleted_at IS NULL
    DO UPDATE SET enabled = EXCLUDED.enabled, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by`

  // Only organization-wide changes are audited. A person choosing their own row height is
  // not a governance event, and filling the trail with those would bury the ones that are.
  if (input.scope === 'organization') {
    await writeAudit(ctx, {
      actorType: actor.type,
      actorId: actor.userId,
      action: 'feature_flag.set',
      entityType: 'settings',
      entityId: null,
      after: { flag, enabled: input.enabled, reason: input.reason?.trim() ?? null },
    })
  }
  return flagStates(ctx, actor)
}

/** Removes an override, returning the flag to the layer beneath it. */
export async function clearFlag(
  ctx: TenantContext,
  actor: Actor,
  input: { flag: string; scope: FlagScope },
): Promise<FlagState[]> {
  guardWrite(ctx, actor, input.scope)

  await ctx.sql`
    UPDATE feature_flag_overrides SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND flag = ${input.flag} AND deleted_at IS NULL
      AND user_id IS ${input.scope === 'user' ? ctx.sql`NOT DISTINCT FROM ${actor.userId}` : ctx.sql`NULL`}`

  if (input.scope === 'organization') {
    await writeAudit(ctx, {
      actorType: actor.type,
      actorId: actor.userId,
      action: 'feature_flag.cleared',
      entityType: 'settings',
      entityId: null,
      before: { flag: input.flag },
    })
  }
  return flagStates(ctx, actor)
}
