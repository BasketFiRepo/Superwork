import type { TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * The connection registry (§13.3).
 *
 * A connection records what capability is wired up, in which mode, by whom, with what
 * scopes and what its last health check said. Nothing here stores a credential: secrets
 * belong in the secret store, and the row exists so an admin can answer "what is
 * connected, is it working, and who connected it".
 */

export interface ConnectionView {
  id: string
  capability: string
  vendor: string
  mode: 'mock' | 'sandbox' | 'live'
  status: 'connected' | 'degraded' | 'disconnected' | 'revoked'
  scopes: string[]
  externalAccount: string | null
  health: { ok?: boolean; message?: string; errorRate?: number; tokenExpiresAt?: string | null }
  lastSyncAt: Date | null
  lastError: string | null
  connectedByName: string | null
  connectedAt: Date
  revokedAt: Date | null
}

function guard(ctx: TenantContext, actor: Actor, action: string): void {
  const decision = can(actor, action, {
    type: 'integration',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function listConnections(ctx: TenantContext, actor: Actor): Promise<ConnectionView[]> {
  guard(ctx, actor, 'integration:read')
  return ctx.sql<ConnectionView[]>`
    SELECT c.id, c.capability, c.vendor, c.mode::text AS mode, c.status, c.scopes,
           c.external_account AS "externalAccount", c.health, c.last_sync_at AS "lastSyncAt",
           c.last_error AS "lastError", u.name AS "connectedByName",
           c.connected_at AS "connectedAt", c.revoked_at AS "revokedAt"
    FROM integration_connections c
    LEFT JOIN users u ON u.id = c.connected_by
    WHERE c.organization_id = ${ctx.organizationId} AND c.deleted_at IS NULL
    ORDER BY c.capability`
}

export async function connectCapability(
  ctx: TenantContext,
  actor: Actor,
  input: {
    capability: string
    vendor: string
    mode: 'mock' | 'sandbox' | 'live'
    scopes?: string[]
    externalAccount?: string | null
    health?: Record<string, unknown>
  },
): Promise<ConnectionView> {
  guard(ctx, actor, 'integration:update')
  if (input.mode === 'live') {
    // Live credentials arrive through the secret store and the OAuth callback, never
    // through this form. Saying so is better than a button that pretends otherwise.
    throw new ValidationError(
      'Connecting a live provider needs credentials configured in the environment. This build ships the simulated providers.',
    )
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO integration_connections (
      organization_id, capability, vendor, mode, status, scopes, external_account,
      health, connected_by, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.capability}, ${input.vendor}, ${input.mode}::sw_runtime_mode,
      'connected', ${input.scopes ?? []}, ${input.externalAccount ?? null},
      ${ctx.sql.json(asJson(input.health ?? {}))}, ${actor.userId}, ${ctx.userId}
    )
    ON CONFLICT (organization_id, capability) WHERE deleted_at IS NULL
    DO UPDATE SET vendor = EXCLUDED.vendor, mode = EXCLUDED.mode, status = 'connected',
                  scopes = EXCLUDED.scopes, external_account = EXCLUDED.external_account,
                  health = EXCLUDED.health, connected_by = EXCLUDED.connected_by,
                  connected_at = now(), revoked_at = NULL, last_error = NULL
    RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'integration.connected',
    entityType: 'integration',
    entityId: row!.id,
    after: { capability: input.capability, vendor: input.vendor, mode: input.mode },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'connected',
    entityType: 'integration',
    entityId: row!.id,
    entityLabel: input.capability,
    summary: `Connected ${input.capability} to ${input.vendor} in ${input.mode} mode.`,
  })

  const connections = await listConnections(ctx, actor)
  return connections.find((connection) => connection.capability === input.capability)!
}

export async function disconnectCapability(
  ctx: TenantContext,
  actor: Actor,
  capability: string,
  reason: string,
): Promise<void> {
  guard(ctx, actor, 'integration:update')
  if (!reason.trim()) throw new ValidationError('Say why it is being disconnected — features will degrade because of it.')

  await ctx.sql`
    UPDATE integration_connections
    SET status = 'disconnected', revoked_at = now(), last_error = ${reason}
    WHERE organization_id = ${ctx.organizationId} AND capability = ${capability} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'integration.disconnected',
    entityType: 'integration',
    entityId: null,
    after: { capability, reason },
  })
}

export async function recordHealth(
  ctx: TenantContext,
  capability: string,
  health: { ok: boolean; message: string; errorRate: number; tokenExpiresAt: Date | null },
): Promise<void> {
  await ctx.sql`
    UPDATE integration_connections
    SET health = ${ctx.sql.json(asJson({
      ok: health.ok,
      message: health.message,
      errorRate: health.errorRate,
      tokenExpiresAt: health.tokenExpiresAt ? health.tokenExpiresAt.toISOString() : null,
      checkedAt: new Date().toISOString(),
    }))},
        status = ${health.ok ? 'connected' : 'degraded'},
        last_sync_at = ${health.ok ? new Date() : null},
        last_error = ${health.ok ? null : health.message}
    WHERE organization_id = ${ctx.organizationId} AND capability = ${capability} AND deleted_at IS NULL`
}
