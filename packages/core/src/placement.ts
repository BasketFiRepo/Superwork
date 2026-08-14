import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'

/**
 * Tenant placement: shards and dedicated tiers (§26.10).
 *
 * A tenant lives on a shard. Most live together on `primary`; a large or contractually
 * isolated one gets a shard of its own. The registry is the *only* place that mapping
 * exists, so a connection is never guessed from a tenant id, and a migration is a state
 * on the row rather than a deploy-day secret.
 *
 * This build runs a single shard. The registry, the resolver and the migration states are
 * real; what is absent is a second physical database, and the resolver says so rather than
 * pretending a `dedicated` tier already isolates anything.
 */

export interface Placement {
  organizationId: string
  shard: string
  tier: 'shared' | 'dedicated'
  region: string
  migratingTo: string | null
  migrationStartedAt: Date | null
  notes: string | null
}

export interface ShardTarget {
  shard: string
  /** The environment variable holding this shard's connection string. */
  connectionEnvVar: string
  /** False when the shard is named but not configured in this deployment. */
  configured: boolean
}

const PRIMARY: ShardTarget = { shard: 'primary', connectionEnvVar: 'DATABASE_URL', configured: true }

/** Where a tenant's data lives. Reads follow the source shard until a migration cuts over. */
export function resolveShard(placement: Placement | null): ShardTarget {
  if (!placement || placement.shard === 'primary') return PRIMARY
  const envVar = `DATABASE_URL_${placement.shard.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  return {
    shard: placement.shard,
    connectionEnvVar: envVar,
    configured: Boolean(process.env[envVar]),
  }
}

export async function placementFor(ctx: TenantContext): Promise<Placement | null> {
  const [row] = await ctx.sql<Placement[]>`
    SELECT organization_id AS "organizationId", shard, tier, region,
           migrating_to AS "migratingTo", migration_started_at AS "migrationStartedAt", notes
    FROM tenant_placements
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  return row ?? null
}

export async function setPlacement(
  ctx: TenantContext,
  actor: Actor,
  input: { shard: string; tier: 'shared' | 'dedicated'; region: string; notes?: string },
): Promise<Placement> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const target = resolveShard({ ...input, organizationId: ctx.organizationId, migratingTo: null, migrationStartedAt: null, notes: null })
  if (!target.configured) {
    throw new ValidationError(
      `Shard "${input.shard}" has no connection configured (${target.connectionEnvVar}). Moving a tenant to a shard ` +
        `that does not exist would lose it, so this is refused rather than recorded.`,
    )
  }

  await ctx.sql`
    INSERT INTO tenant_placements (organization_id, shard, tier, region, notes, created_by)
    VALUES (${ctx.organizationId}, ${input.shard}, ${input.tier}, ${input.region}, ${input.notes ?? null}, ${ctx.userId})
    ON CONFLICT (organization_id) WHERE deleted_at IS NULL
    DO UPDATE SET shard = EXCLUDED.shard, tier = EXCLUDED.tier, region = EXCLUDED.region, notes = EXCLUDED.notes`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'placement.set',
    entityType: 'organization',
    entityId: ctx.organizationId,
    after: { shard: input.shard, tier: input.tier, region: input.region },
  })

  return (await placementFor(ctx))!
}

/**
 * Marks a move as started. The tenant keeps reading from its current shard until the
 * cutover — a placement row that flips the moment somebody clicks is how a migration
 * loses writes.
 */
export async function beginMigration(
  ctx: TenantContext,
  actor: Actor,
  toShard: string,
): Promise<Placement> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  await ctx.sql`
    UPDATE tenant_placements SET migrating_to = ${toShard}, migration_started_at = now()
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'placement.migration_started',
    entityType: 'organization',
    entityId: ctx.organizationId,
    after: { toShard },
  })

  return (await placementFor(ctx))!
}
