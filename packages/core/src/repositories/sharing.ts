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
/**
 * `task` was missing, while `listTasks` already unioned shared task ids into its scope
 * predicate — so that branch could never match. Sharing one task with one person is the
 * most ordinary act of collaboration there is; leaving it out made the union dead code.
 */
export type ShareableType = 'project' | 'document' | 'knowledge_space' | 'company' | 'task'

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
  /** What the object is called, so a list of shares reads as something other than uuids. */
  objectLabel: string | null
  /** True when the grant has lapsed. `loadActor` already ignores these; the screen must too. */
  expired: boolean
  /** How this reached the person: directly, or through a team or department they belong to. */
  via: 'you' | 'team' | 'department'
  /** Who granted it, so the granter can take it back again. */
  grantedById: string | null
  /** Whether *this* reader may revoke it — the Revoke button is disabled when they cannot. */
  canRevoke: boolean
}

/**
 * The object's own name, resolved per type. A share list showing `document` and a uuid is a
 * list nobody can act on — the whole question being answered is "what did I give them".
 */
const OBJECT_LABEL = (ctx: TenantContext) => ctx.sql`
  CASE t.object_type
    WHEN 'task'            THEN (SELECT x.title FROM tasks x WHERE x.id = t.object_id)
    WHEN 'document'        THEN (SELECT x.title FROM documents x WHERE x.id = t.object_id)
    WHEN 'project'         THEN (SELECT x.name FROM projects x WHERE x.id = t.object_id)
    WHEN 'company'         THEN (SELECT x.name FROM companies x WHERE x.id = t.object_id)
    WHEN 'knowledge_space' THEN (SELECT x.name FROM knowledge_spaces x WHERE x.id = t.object_id)
  END`

/** The verb a relation implies, used to check the granter holds at least as much. */
const VERB_FOR_RELATION: Record<Relation, string> = {
  viewer: 'read',
  editor: 'update',
  approver: 'update',
  owner: 'update',
}

/**
 * Which relations this actor could actually grant on this object.
 *
 * The panel used to offer all four to everybody, so a member — who holds `project:read:org`
 * but not `project:update` — could pick "can change it" and be refused after filling the
 * form in. Same rule, same table, asked before the button is drawn rather than after it is
 * pressed (§2, every button does something).
 */
export function shareableRelations(
  actor: Actor,
  objectType: ShareableType,
  objectId: string,
  organizationId: string,
): Relation[] {
  return (Object.keys(VERB_FOR_RELATION) as Relation[]).filter(
    (relation) =>
      can(actor, `${objectType}:${VERB_FOR_RELATION[relation]}`, {
        type: objectType,
        id: objectId,
        organizationId,
        riskTier: 'low',
      }).allow,
  )
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
  const [tuple] = await ctx.sql<{ grantedBy: string | null }[]>`
    SELECT granted_by AS "grantedBy" FROM relation_tuples
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.tupleId} AND deleted_at IS NULL`
  if (!tuple) throw new NotFoundError()

  // You can always take back what you gave. Revoking only ever narrows, so this cannot
  // widen anybody's access — and requiring `update` on the object meant a member who could
  // share a project as a viewer (they hold `project:read`) could not undo it afterwards.
  // A grant you cannot withdraw is worse than one you cannot make.
  const mine = tuple.grantedBy === actor.userId
  if (!mine) {
    const decision = can(actor, `${input.objectType}:update`, {
      type: input.objectType,
      id: input.objectId,
      organizationId: ctx.organizationId,
      riskTier: 'low',
    })
    if (!decision.allow) {
      throw new PermissionError(
        `${decision.reason} You can always revoke a share you granted yourself; this one was granted by somebody else.`,
      )
    }
  }

  await ctx.sql`
    UPDATE relation_tuples SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.tupleId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'sharing.revoked',
    entityType: input.objectType,
    entityId: input.objectId,
    after: { tupleId: input.tupleId, ...(mine ? { revokedOwnGrant: true } : {}) },
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

  const mayRevokeAny = can(actor, `${objectType}:update`, {
    type: objectType,
    id: objectId,
    organizationId: ctx.organizationId,
    riskTier: 'low',
  }).allow

  const rows = await ctx.sql<ShareView[]>`
    SELECT t.id, t.subject_type AS "subjectType", t.subject_id AS "subjectId",
           coalesce(u.name, tm.name, d.name) AS "subjectName",
           t.relation, t.object_type AS "objectType", t.object_id AS "objectId",
           t.reason, t.granted_by AS "grantedById", g.name AS "grantedByName",
           t.expires_at AS "expiresAt", t.created_at AS "createdAt",
           ${OBJECT_LABEL(ctx)} AS "objectLabel",
           -- Shown rather than filtered out: "this lapsed on Tuesday" is the answer
           -- somebody is looking for when they ask why a colleague lost access.
           (t.expires_at IS NOT NULL AND t.expires_at <= now()) AS expired,
           'you' AS via, false AS "canRevoke"
    FROM relation_tuples t
    LEFT JOIN users u ON t.subject_type = 'user' AND u.id = t.subject_id
    LEFT JOIN teams tm ON t.subject_type = 'team' AND tm.id = t.subject_id
    LEFT JOIN departments d ON t.subject_type = 'department' AND d.id = t.subject_id
    LEFT JOIN users g ON g.id = t.granted_by
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.object_type = ${objectType} AND t.object_id = ${objectId}
    ORDER BY t.created_at DESC`

  return rows.map((row) => ({ ...row, canRevoke: mayRevokeAny || row.grantedById === actor.userId }))
}

/**
 * Everything shared *with* somebody — the answer to "why can they see this?".
 *
 * Includes the grants that reach them through a team or department, not only the ones
 * naming them directly. `loadActor` has always resolved all three when it builds the
 * relation set, so listing only the direct ones answered the question wrongly: somebody
 * would see an object they could not account for, which is precisely the confusion this
 * view exists to end.
 */
export async function sharedWith(
  ctx: TenantContext,
  actor: Actor,
  userId: string,
): Promise<ShareView[]> {
  // Self only, like `personalRecord` and `listDisclosures` beside it. This used to require
  // `member:read`, which *every* role holds down to `guest` — so any colleague could list
  // what somebody else had been given. Nothing is lost by closing it: an administrator
  // reviewing access reads it from the object end with `listShares`, where the same facts
  // live and the permission is the object's own.
  if (userId !== actor.userId) {
    throw new PermissionError(
      'This shows what has been shared with you. To review who can reach something, open the thing itself.',
    )
  }

  return ctx.sql<ShareView[]>`
    SELECT t.id, t.subject_type AS "subjectType", t.subject_id AS "subjectId",
           coalesce(u.name, tm.name, d.name) AS "subjectName",
           t.relation, t.object_type AS "objectType", t.object_id AS "objectId",
           t.reason, t.granted_by AS "grantedById", g.name AS "grantedByName",
           t.expires_at AS "expiresAt", t.created_at AS "createdAt",
           ${OBJECT_LABEL(ctx)} AS "objectLabel",
           false AS expired,
           CASE t.subject_type WHEN 'user' THEN 'you' ELSE t.subject_type END AS via,
           -- Revoking is done from the object's own panel, where the permission is the
           -- object's. This view is "what have I been given", not a place to give it back.
           false AS "canRevoke"
    FROM relation_tuples t
    LEFT JOIN users u ON t.subject_type = 'user' AND u.id = t.subject_id
    LEFT JOIN teams tm ON t.subject_type = 'team' AND tm.id = t.subject_id
    LEFT JOIN departments d ON t.subject_type = 'department' AND d.id = t.subject_id
    LEFT JOIN users g ON g.id = t.granted_by
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > now())
      AND (
        (t.subject_type = 'user' AND t.subject_id = ${userId})
        OR (t.subject_type = 'team' AND t.subject_id IN (
              SELECT team_id FROM team_members
              WHERE organization_id = ${ctx.organizationId} AND user_id = ${userId} AND deleted_at IS NULL))
        OR (t.subject_type = 'department' AND t.subject_id IN (
              SELECT department_id FROM memberships
              WHERE organization_id = ${ctx.organizationId} AND user_id = ${userId}
                AND deleted_at IS NULL AND department_id IS NOT NULL))
      )
    ORDER BY t.created_at DESC`
}
