import { createHash, randomBytes } from 'node:crypto'
import type { Role, TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import type { DirectoryUser } from '@superwork/integrations'
import { PermissionError, ValidationError } from '../errors.js'
import { assertSteppedUp } from '../step-up.js'
import { writeAudit } from '../audit.js'
import { isPrivateHost } from './custom-tools.js'

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
    /** Where the directory publishes the key that signs its assertions (ADR 0087). */
    ssoMetadataUrl?: string | null
    verifiedDomains: string[]
    jitProvisioning: boolean
    defaultRole: Role
    scimEnabled: boolean
  },
): Promise<IdentitySettings & { scimToken?: string }> {
  guard(ctx, actor, 'settings:update')

  // Where the assertions come from (ADR 0087). An assertion is a claim signed by somebody, and
  // this is where that somebody's signing key is published — so single sign-on that is *on* with
  // no metadata URL is a claim with no source behind it. The database says the same thing, because
  // a pair like this is exactly the kind that drifts when only one half is checked.
  const metadataUrl = input.ssoMetadataUrl?.trim() || null
  if (metadataUrl !== null) assertMetadataUrl(metadataUrl)
  if (input.ssoEnabled && metadataUrl === null) {
    throw new ValidationError(
      'Single sign-on needs the directory’s metadata URL — it is where the key that signs an ' +
        'assertion is published. Without one, Superwork would be trusting whatever arrived.',
    )
  }

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
      organization_id, sso_enabled, sso_provider, sso_metadata_url, verified_domains,
      jit_provisioning, default_role, scim_enabled, scim_token_hash, scim_token_prefix, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.ssoEnabled}, ${input.ssoProvider ?? null}, ${metadataUrl},
      ${input.verifiedDomains}, ${input.jitProvisioning}, ${input.defaultRole}::sw_role,
      ${input.scimEnabled}, ${scimHash}, ${scimPrefix}, ${ctx.userId}
    )
    ON CONFLICT (organization_id) WHERE deleted_at IS NULL
    DO UPDATE SET sso_enabled = EXCLUDED.sso_enabled, sso_provider = EXCLUDED.sso_provider,
                  sso_metadata_url = EXCLUDED.sso_metadata_url,
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
      ssoMetadataUrl: metadataUrl,
      scim: input.scimEnabled,
      jit: input.jitProvisioning,
      domains: input.verifiedDomains.join(', '),
      defaultRole: input.defaultRole,
    },
  })

  const settings = await identitySettings(ctx, actor)
  return scimToken ? { ...settings, scimToken } : settings
}

/**
 * The metadata URL, checked the way a custom tool's host is (ADR 0050).
 *
 * `https` only, because the document it points at is what decides whose signature to trust, and a
 * plaintext one can be rewritten in transit by exactly the person who benefits. No private or
 * link-local address, for the same reason a tool may not name one: a URL the server fetches is a
 * request somebody else chose the destination of.
 */
export function assertMetadataUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ValidationError(`"${value}" is not a URL. Give the address the directory publishes its metadata at.`)
  }
  if (url.protocol !== 'https:') {
    throw new ValidationError('The metadata URL must be https. What it points at decides whose signature to trust.')
  }
  if (isPrivateHost(url.hostname.toLowerCase())) {
    throw new ValidationError(
      `Superwork will not fetch metadata from ${url.hostname} — it is a private or link-local address.`,
    )
  }
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

export interface Residency {
  /** Where the data is. */
  region: string
  /** Where this organization has said it may go. Its own to narrow (ADR 0074). */
  allowed: string[]
  /** Where somebody actually provisioned a database. The ceiling, and not a setting. */
  provisioned: string[]
  setByName: string | null
  setAt: Date | null
  reason: string | null
}

export async function residency(ctx: TenantContext, actor: Actor): Promise<Residency> {
  guard(ctx, actor, 'settings:read')
  const [row] = await ctx.sql<
    {
      region: string
      allowed: string[]
      provisioned: string[]
      setByName: string | null
      setAt: Date | null
      reason: string | null
    }[]
  >`
    SELECT o.data_region AS region, o.allowed_regions AS allowed,
           o.provisioned_regions AS provisioned, u.name AS "setByName",
           o.allowed_regions_set_at AS "setAt", o.allowed_regions_reason AS reason
    FROM organizations o
    LEFT JOIN users u ON u.id = o.allowed_regions_set_by
    WHERE o.id = ${ctx.organizationId}`
  return {
    region: row?.region ?? 'eu',
    allowed: row?.allowed ?? ['eu'],
    provisioned: row?.provisioned ?? ['eu'],
    setByName: row?.setByName ?? null,
    setAt: row?.setAt ?? null,
    reason: row?.reason ?? null,
  }
}

/**
 * Where this organization's data may go (ADR 0074).
 *
 * `allowed_regions` was read by four things and written by nothing, so every organization was
 * stuck at the column's default and the residency panel refused two of the three regions it
 * offered — with a message naming a provisioning act nobody could perform.
 *
 * The repair is not a tick-box that adds a region. A settings screen cannot make a database exist
 * in Ohio, and an organization recording that it may keep data somewhere it has none would be
 * writing down something untrue — then `setResidency` would be free to move there. So there are
 * two levels, the arrangement `plan_limits` and `subscriptions` already use for spend: a ceiling
 * somebody provisioned, and beneath it a restriction the organization sets on itself.
 *
 * **Narrowing asks for nothing but a reason.** "Our data must never leave the EU" is a promise a
 * company makes about itself, and a control that interrogated somebody for making a stronger
 * promise would be the wrong way round.
 *
 * **Widening asks for a password**, because it widens — the direction rule, unchanged since 0044.
 *
 * **Widening past the ceiling is refused**, and the refusal names what would actually work rather
 * than naming provisioning in the passive voice at somebody who cannot do it.
 */
export async function setAllowedRegions(
  ctx: TenantContext,
  actor: Actor,
  input: { regions: string[]; reason: string },
): Promise<Residency> {
  guard(ctx, actor, 'settings:update')
  const current = await residency(ctx, actor)

  const wanted = [...new Set(input.regions)].sort()
  const known = wanted.filter((region) => !REGIONS.some((entry) => entry.id === region))
  if (known.length > 0) {
    throw new ValidationError(`Superwork has no region called ${known.join(', ')}.`)
  }
  if (wanted.length === 0) {
    throw new ValidationError('Data has to live somewhere. Leave at least one region.')
  }
  if (!input.reason?.trim()) {
    throw new ValidationError(
      'Say why. Somebody will ask, in a room where "it has always been like that" is not an answer.',
    )
  }

  const unprovisioned = wanted.filter((region) => !current.provisioned.includes(region))
  if (unprovisioned.length > 0) {
    const names = unprovisioned.map((id) => REGIONS.find((entry) => entry.id === id)?.label ?? id)
    throw new ValidationError(
      `Superwork holds no database for this organization in ${names.join(' or ')}, so it cannot promise to keep ` +
        `your data there. Provisioning a region means moving data into it — ask us to do that, and this list ` +
        `grows when it is true. You are provisioned for ${current.provisioned.join(', ')}.`,
    )
  }

  // The database refuses this too, through `data_region_allowed`. It is caught here so the
  // person reads a sentence rather than a constraint name.
  if (!wanted.includes(current.region)) {
    throw new ValidationError(
      `Your data is in ${current.region} right now, so that is not a region you can rule out. Move it first, ` +
        `then rule this one out.`,
    )
  }

  const widening = wanted.filter((region) => !current.allowed.includes(region))
  if (widening.length > 0) assertSteppedUp(actor, 'settings.widen_data_regions')

  await ctx.sql`
    UPDATE organizations
    SET allowed_regions = ${wanted},
        allowed_regions_set_by = ${actor.userId},
        allowed_regions_set_at = now(),
        allowed_regions_reason = ${input.reason.trim()}
    WHERE id = ${ctx.organizationId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'settings.allowed_regions_changed',
    entityType: 'organization',
    entityId: ctx.organizationId,
    before: { allowed: current.allowed },
    after: { allowed: wanted, reason: input.reason.trim(), widened: widening },
  })

  return residency(ctx, actor)
}

/**
 * Changing region is a migration, not a toggle. This records the intent and refuses a
 * region the tenant is not provisioned for, rather than pretending data has moved.
 */
export async function setResidency(ctx: TenantContext, actor: Actor, region: string): Promise<void> {
  guard(ctx, actor, 'settings:update')
  const current = await residency(ctx, actor)
  if (!current.allowed.includes(region)) {
    // Two refusals, because there are now two reasons and they need different answers from the
    // reader. The old message said "provisioned" for both, which named an act nobody could
    // perform even in the case where the answer was one click away (ADR 0074).
    throw new ValidationError(
      current.provisioned.includes(region)
        ? `This organization has ruled ${region} out of where its data may be kept. Allow it again first — that ` +
          `asks for your password, because it widens.`
        : `This organization is provisioned for ${current.provisioned.join(', ')}. Moving to ${region} is a ` +
          `migration, not a setting — it needs the data moved first, and Superwork will not claim otherwise.`,
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
