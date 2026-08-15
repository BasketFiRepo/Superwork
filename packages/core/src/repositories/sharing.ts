import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { syncShareToAudience } from './document-audience.js'

/**
 * Sharing, as relation tuples (§4.6).
 *
 * A role answers "what may this kind of person do"; a tuple answers "what may this person
 * do with this thing". Sharing one project with a colleague should not change their role,
 * and a role should not have to be invented for every act of collaboration.
 *
 * Two rules keep the model honest:
 *   • you can only share what you could already share — the grant is checked against the
 *     granter's own permission on the object, so a tuple can never manufacture reach;
 *   • every tuple carries who granted it and why, and can expire.
 */

export type Relation = 'viewer' | 'editor' | 'owner' | 'approver'
export type ShareableType = 'project' | 'document' | 'knowledge_space' | 'company'

const RELATION_RANK: Record<Relation, number> = { viewer: 0, editor: 1, approver: 2, owner: 3 }

export interface ShareView {
  id: string
  subjectType: 'user' | 'team' | 'department'
  subjectId: string
  subjectName: string | null
  relation: Relation
  objectType: ShareableType
  objectId: string
  reason: string | null
  grantedByName: string | null
  expiresAt: Date | null
  createdAt: Date
}

/** The verb a relation implies, used to check the granter holds at least as much. */
const VERB_FOR_RELATION: Record<Relation, string> = {
  viewer: 'read',
  editor: 'update',
  approver: 'update',
  owner: 'update',
}

export async function share(
  ctx: TenantContext,
  actor: Actor,
  input: {
    subjectType: 'user' | 'team' | 'department'
    subjectId: string
    relation: Relation
    objectType: ShareableType
    objectId: string
    reason?: string
    expiresAt?: Date | null
  },
): Promise<ShareView> {
  // You cannot grant what you do not hold.
  const decision = can(actor, `${input.objectType}:${VERB_FOR_RELATION[input.relation]}`, {
    type: input.objectType,
    id: input.objectId,
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) {
    throw new PermissionError(
      `You can only share something you can ${VERB_FOR_RELATION[input.relation]} yourself. ${decision.reason}`,
    )
  }
  if (!RELATION_RANK[input.relation] && input.relation !== 'viewer') {
    throw new ValidationError('Unknown relation.')
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO relation_tuples (
      organization_id, subject_type, subject_id, relation, object_type, object_id,
      granted_by, reason, expires_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.subjectType}, ${input.subjectId}, ${input.relation},
      ${input.objectType}, ${input.objectId}, ${actor.userId}, ${input.reason ?? null},
      ${input.expiresAt ?? null}, ${ctx.userId}
    )
    ON CONFLICT (organization_id, subject_type, subject_id, relation, object_type, object_id)
      WHERE deleted_at IS NULL
    DO UPDATE SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, granted_by = EXCLUDED.granted_by
    RETURNING id`

  // A tuple grants `document:read` through `can()`, which lets the recipient open the
  // document's page — but retrieval consults the circulation list, not tuples. Without
  // this, sharing a restricted document left "I shared it with you" and "the assistant
  // cannot find it" both true.
  let addedToAudience = false
  if (input.objectType === 'document') {
    addedToAudience = await syncShareToAudience(ctx, actor, {
      documentId: input.objectId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reason: input.reason,
    })
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'sharing.granted',
    entityType: input.objectType,
    entityId: input.objectId,
    after: {
      subject: `${input.subjectType}:${input.subjectId}`,
      relation: input.relation,
      ...(addedToAudience ? { addedToCirculationList: true } : {}),
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'shared',
    entityType: input.objectType,
    entityId: input.objectId,
    entityLabel: input.objectType,
    summary: `Shared as ${input.relation}.${input.reason ? ` ${input.reason}` : ''}`,
  })

  const shares = await listShares(ctx, actor, input.objectType, input.objectId)
  const created = shares.find((entry) => entry.id === row!.id)
  if (!created) throw new NotFoundError()
  return created
}

export async function unshare(
  ctx: TenantContext,
  actor: Actor,
  input: { objectType: ShareableType; objectId: string; tupleId: string },
): Promise<void> {
  const decision = can(actor, `${input.objectType}:update`, {
    type: input.objectType,
    id: input.objectId,
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  await ctx.sql`
    UPDATE relation_tuples SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.tupleId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'sharing.revoked',
    entityType: input.objectType,
    entityId: input.objectId,
    after: { tupleId: input.tupleId },
  })
}

export async function listShares(
  ctx: TenantContext,
  actor: Actor,
  objectType: ShareableType,
  objectId: string,
): Promise<ShareView[]> {
  const decision = can(actor, `${objectType}:read`, {
    type: objectType,
    id: objectId,
    organizationId: ctx.organizationId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  return ctx.sql<ShareView[]>`
    SELECT t.id, t.subject_type AS "subjectType", t.subject_id AS "subjectId",
           coalesce(u.name, tm.name, d.name) AS "subjectName",
           t.relation, t.object_type AS "objectType", t.object_id AS "objectId",
           t.reason, g.name AS "grantedByName", t.expires_at AS "expiresAt", t.created_at AS "createdAt"
    FROM relation_tuples t
    LEFT JOIN users u ON t.subject_type = 'user' AND u.id = t.subject_id
    LEFT JOIN teams tm ON t.subject_type = 'team' AND tm.id = t.subject_id
    LEFT JOIN departments d ON t.subject_type = 'department' AND d.id = t.subject_id
    LEFT JOIN users g ON g.id = t.granted_by
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.object_type = ${objectType} AND t.object_id = ${objectId}
    ORDER BY t.created_at DESC`
}

/** Everything shared *with* somebody — the answer to "why can they see this?". */
export async function sharedWith(
  ctx: TenantContext,
  actor: Actor,
  userId: string,
): Promise<ShareView[]> {
  if (userId !== actor.userId) {
    const decision = can(actor, 'member:read', { type: 'member', organizationId: ctx.organizationId })
    if (!decision.allow) throw new PermissionError(decision.reason)
  }

  return ctx.sql<ShareView[]>`
    SELECT t.id, t.subject_type AS "subjectType", t.subject_id AS "subjectId", u.name AS "subjectName",
           t.relation, t.object_type AS "objectType", t.object_id AS "objectId",
           t.reason, g.name AS "grantedByName", t.expires_at AS "expiresAt", t.created_at AS "createdAt"
    FROM relation_tuples t
    LEFT JOIN users u ON u.id = t.subject_id
    LEFT JOIN users g ON g.id = t.granted_by
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.subject_type = 'user' AND t.subject_id = ${userId}
      AND (t.expires_at IS NULL OR t.expires_at > now())
    ORDER BY t.created_at DESC`
}
