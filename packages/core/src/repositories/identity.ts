import { createHash, randomBytes } from 'node:crypto'
import type { Role, TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import type { DirectoryUser } from '@superwork/integrations'
import { PermissionError, ValidationError } from '../errors.js'
import { writeAudit } from '../audit.js'

/**
 * Identity and residency (§23).
 *
 * SSO and SCIM are a mirror, never a source of truth about permissions: the directory
 * says who exists and who has left; Superwork still decides what each of them may do.
 * Provisioning is previewed before it is applied, and a person is deactivated rather than
 * deleted, because deleting a colleague's account destroys the trail of what they did.
 */

export interface IdentitySettings {
  ssoEnabled: boolean
  ssoProvider: string | null
  ssoMetadataUrl: string | null
  verifiedDomains: string[]
  jitProvisioning: boolean
  defaultRole: Role
  scimEnabled: boolean
  scimTokenPrefix: string | null
  lastSyncAt: Date | null
  lastSyncSummary: { created?: number; updated?: number; deactivated?: number; at?: string } | null
}

function guard(ctx: TenantContext, actor: Actor, action: string): void {
  const decision = can(actor, action, {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function identitySettings(ctx: TenantContext, actor: Actor): Promise<IdentitySettings> {
  guard(ctx, actor, 'settings:read')
  const [row] = await ctx.sql<
    {
      ssoEnabled: boolean
      ssoProvider: string | null
      ssoMetadataUrl: string | null
      verifiedDomains: string[]
      jitProvisioning: boolean
      defaultRole: Role
      scimEnabled: boolean
      scimTokenPrefix: string | null
      lastSyncAt: Date | null
      lastSyncSummary: IdentitySettings['lastSyncSummary']
    }[]
  >`
    SELECT sso_enabled AS "ssoEnabled", sso_provider AS "ssoProvider",
           sso_metadata_url AS "ssoMetadataUrl", verified_domains AS "verifiedDomains",
           jit_provisioning AS "jitProvisioning", default_role AS "defaultRole",
           scim_enabled AS "scimEnabled", scim_token_prefix AS "scimTokenPrefix",
           last_sync_at AS "lastSyncAt", last_sync_summary AS "lastSyncSummary"
    FROM identity_settings
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`

  return (
    row ?? {
      ssoEnabled: false,
      ssoProvider: null,
      ssoMetadataUrl: null,
      verifiedDomains: [],
      jitProvisioning: false,
      defaultRole: 'member' as Role,
      scimEnabled: false,
      scimTokenPrefix: null,
      lastSyncAt: null,
      lastSyncSummary: null,
    }
  )
}

export async function updateIdentitySettings(
  ctx: TenantContext,
  actor: Actor,
  input: {
    ssoEnabled: boolean
    ssoProvider?: string | null
    verifiedDomains: string[]
    jitProvisioning: boolean
    defaultRole: Role
    scimEnabled: boolean
  },
): Promise<IdentitySettings & { scimToken?: string }> {
  guard(ctx, actor, 'settings:update')

  if (input.jitProvisioning && input.verifiedDomains.length === 0) {
    throw new ValidationError(
      'Just-in-time provisioning needs at least one verified domain. Without it, anybody who can produce an assertion becomes a colleague.',
    )
  }
  if (input.defaultRole === 'owner' || input.defaultRole === 'admin') {
    throw new ValidationError('New people provisioned automatically may not arrive as owners or admins.')
  }

  // The SCIM token is a credential: generated here, shown once, stored as a hash.
  let scimToken: string | undefined
  let scimHash: string | null = null
  let scimPrefix: string | null = null
  if (input.scimEnabled) {
    const existing = await identitySettings(ctx, actor)
    if (!existing.scimEnabled || !existing.scimTokenPrefix) {
      scimPrefix = `scim_${randomBytes(3).toString('hex')}`
      scimToken = `${scimPrefix}_${randomBytes(24).toString('base64url')}`
      scimHash = createHash('sha256').update(scimToken).digest('hex')
    }
  }

  await ctx.sql`
    INSERT INTO identity_settings (
      organization_id, sso_enabled, sso_provider, verified_domains, jit_provisioning,
      default_role, scim_enabled, scim_token_hash, scim_token_prefix, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.ssoEnabled}, ${input.ssoProvider ?? null},
      ${input.verifiedDomains}, ${input.jitProvisioning}, ${input.defaultRole}::sw_role,
      ${input.scimEnabled}, ${scimHash}, ${scimPrefix}, ${ctx.userId}
    )
    ON CONFLICT (organization_id) WHERE deleted_at IS NULL
    DO UPDATE SET sso_enabled = EXCLUDED.sso_enabled, sso_provider = EXCLUDED.sso_provider,
                  verified_domains = EXCLUDED.verified_domains,
                  jit_provisioning = EXCLUDED.jit_provisioning,
                  default_role = EXCLUDED.default_role, scim_enabled = EXCLUDED.scim_enabled,
                  scim_token_hash = coalesce(EXCLUDED.scim_token_hash, identity_settings.scim_token_hash),
                  scim_token_prefix = coalesce(EXCLUDED.scim_token_prefix, identity_settings.scim_token_prefix)`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'identity.settings_updated',
    entityType: 'settings',
    entityId: null,
    after: {
      sso: input.ssoEnabled,
      scim: input.scimEnabled,
      jit: input.jitProvisioning,
      domains: input.verifiedDomains.join(', '),
      defaultRole: input.defaultRole,
    },
  })

  const settings = await identitySettings(ctx, actor)
  return scimToken ? { ...settings, scimToken } : settings
}

export interface DirectoryPlan {
  create: { email: string; displayName: string; department: string | null }[]
  reactivate: { email: string; displayName: string }[]
  deactivate: { email: string; displayName: string }[]
  unchanged: number
  skippedUnverifiedDomain: string[]
}

/**
 * What a sync would do. Nothing is applied until somebody looks at this: a directory sync
 * that silently deactivates half a company is the classic SCIM incident.
 */
export async function planDirectorySync(
  ctx: TenantContext,
  actor: Actor,
  directory: DirectoryUser[],
): Promise<DirectoryPlan> {
  guard(ctx, actor, 'settings:read')
  const settings = await identitySettings(ctx, actor)

  const members = await ctx.sql<{ email: string; name: string; status: string }[]>`
    SELECT u.email, u.name, m.status
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL`

  const byEmail = new Map(members.map((member) => [member.email.toLowerCase(), member]))
  const plan: DirectoryPlan = { create: [], reactivate: [], deactivate: [], unchanged: 0, skippedUnverifiedDomain: [] }
  const seen = new Set<string>()

  for (const entry of directory) {
    const email = entry.email.toLowerCase()
    const domain = email.split('@')[1] ?? ''
    if (settings.verifiedDomains.length > 0 && !settings.verifiedDomains.includes(domain)) {
      plan.skippedUnverifiedDomain.push(entry.email)
      continue
    }
    seen.add(email)
    const existing = byEmail.get(email)
    if (!existing) {
      if (entry.active) plan.create.push({ email: entry.email, displayName: entry.displayName, department: entry.department })
      continue
    }
    if (entry.active && existing.status !== 'active') {
      plan.reactivate.push({ email: entry.email, displayName: entry.displayName })
    } else if (!entry.active && existing.status === 'active') {
      plan.deactivate.push({ email: entry.email, displayName: entry.displayName })
    } else {
      plan.unchanged += 1
    }
  }

  // Somebody in Superwork who is not in the directory at all is *not* deactivated
  // automatically: a partial directory page must never look like a departure.
  return plan
}

export async function applyDirectorySync(
  ctx: TenantContext,
  actor: Actor,
  plan: DirectoryPlan,
): Promise<{ created: number; reactivated: number; deactivated: number }> {
  guard(ctx, actor, 'settings:update')
  const settings = await identitySettings(ctx, actor)

  let created = 0
  for (const person of plan.create) {
    // `ON CONFLICT (email)` matched no constraint: the unique index is on
    // `lower(email) WHERE deleted_at IS NULL`, so this raised rather than updating whenever
    // the person already existed — which is exactly what a re-sync does.
    const [user] = await ctx.sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash, timezone)
      VALUES (${person.email}, ${person.displayName}, ${'sso-only'}, ${ctx.timezone})
      ON CONFLICT (lower(email)) WHERE deleted_at IS NULL
      DO UPDATE SET name = EXCLUDED.name
      RETURNING id`
    await ctx.sql`
      INSERT INTO memberships (organization_id, user_id, role, status, created_by)
      VALUES (${ctx.organizationId}, ${user!.id}, ${settings.defaultRole}::sw_role, 'active', ${ctx.userId})
      ON CONFLICT DO NOTHING`
    created += 1
  }

  let reactivated = 0
  for (const person of plan.reactivate) {
    await ctx.sql`
      UPDATE memberships SET status = 'active'
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND user_id = (SELECT id FROM users WHERE lower(email) = lower(${person.email}))`
    reactivated += 1
  }

  let deactivated = 0
  for (const person of plan.deactivate) {
    // Deactivated, never deleted: their history stays attributable.
    await ctx.sql`
      UPDATE memberships SET status = 'inactive'
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND user_id = (SELECT id FROM users WHERE lower(email) = lower(${person.email}))`
    deactivated += 1
  }

  await ctx.sql`
    UPDATE identity_settings
    SET last_sync_at = now(),
        last_sync_summary = ${ctx.sql.json(asJson({ created, updated: reactivated, deactivated, at: new Date().toISOString() }))}
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'identity.directory_synced',
    entityType: 'settings',
    entityId: null,
    after: { created, reactivated, deactivated },
  })

  return { created, reactivated, deactivated }
}

// ---------------------------------------------------------------------------
// Data residency (§23.4)
// ---------------------------------------------------------------------------

export const REGIONS = [
  { id: 'eu', label: 'European Union', note: 'Data stays in EU regions. Model providers must offer an EU endpoint.' },
  { id: 'uk', label: 'United Kingdom', note: 'UK-only processing, including backups.' },
  { id: 'us', label: 'United States', note: 'US regions.' },
] as const

export async function residency(
  ctx: TenantContext,
  actor: Actor,
): Promise<{ region: string; allowed: string[] }> {
  guard(ctx, actor, 'settings:read')
  const [row] = await ctx.sql<{ data_region: string; allowed_regions: string[] }[]>`
    SELECT data_region, allowed_regions FROM organizations WHERE id = ${ctx.organizationId}`
  return { region: row?.data_region ?? 'eu', allowed: row?.allowed_regions ?? ['eu'] }
}

/**
 * Changing region is a migration, not a toggle. This records the intent and refuses a
 * region the tenant is not provisioned for, rather than pretending data has moved.
 */
export async function setResidency(ctx: TenantContext, actor: Actor, region: string): Promise<void> {
  guard(ctx, actor, 'settings:update')
  const current = await residency(ctx, actor)
  if (!current.allowed.includes(region)) {
    throw new ValidationError(
      `This organization is provisioned for ${current.allowed.join(', ')}. Moving to ${region} is a migration, ` +
        `not a setting — it needs the data moved first, and Superwork will not claim otherwise.`,
    )
  }

  await ctx.sql`
    UPDATE organizations SET data_region = ${region} WHERE id = ${ctx.organizationId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'settings.residency_changed',
    entityType: 'organization',
    entityId: ctx.organizationId,
    before: { region: current.region },
    after: { region },
  })
}
