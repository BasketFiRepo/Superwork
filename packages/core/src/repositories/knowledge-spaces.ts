import type { Sensitivity, TenantContext } from '@superwork/db'
import { can, grantedScope, sharedObjectIds, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError } from '../errors.js'

/**
 * Knowledge spaces (§8.1).
 *
 * `knowledge_spaces` was created in migration 0004, seeded with one row, and read by
 * nothing. `documents.space_id` was written on every seeded document and never selected.
 * The library therefore had no notion of which shelf anything sat on, while the schema had
 * carried one all along.
 *
 * A space is a container in the sense ADR 0024 means: the documents in it have no other
 * home. So sharing one lends a read of what is inside it — and, as ever, never a say.
 *
 * A space carries no classification of its own. `default_sensitivity` is the default
 * applied to documents filed into it, not a statement about the space, so it is *not* used
 * as a container ceiling. Each document is checked against its own classification, which is
 * where the classification actually lives.
 */

export interface SpaceView {
  id: string
  name: string
  slug: string
  description: string | null
  defaultSensitivity: Sensitivity
  departmentId: string | null
  departmentName: string | null
  documentCount: number
  createdAt: Date
}

const SELECT_SPACE = (ctx: TenantContext) => ctx.sql`
  SELECT s.id, s.name, s.slug, s.description,
         s.default_sensitivity AS "defaultSensitivity",
         s.department_id AS "departmentId", d.path AS "departmentName",
         (SELECT count(*)::int FROM documents doc
           WHERE doc.space_id = s.id AND doc.deleted_at IS NULL) AS "documentCount",
         s.created_at AS "createdAt"
  FROM knowledge_spaces s
  LEFT JOIN departments d ON d.id = s.department_id`

export async function listSpaces(ctx: TenantContext, actor: Actor): Promise<SpaceView[]> {
  // `knowledge`, not `knowledge_space`: the permission catalogue spells the domain that way
  // and a space is part of it. Getting this wrong is what made the type unshareable.
  const scope = grantedScope(actor, 'knowledge:read', 'knowledge')
  const sql = ctx.sql
  const shared = sharedObjectIds(actor, 'knowledge_space')

  // A role with no `knowledge` grant at all — `guest` holds none — can still have been
  // *given* a space, and a gate that throws before any row is considered would deny the
  // one thing the tuple exists to allow. Refuse only when there is genuinely nothing to
  // ask about (ADR 0021, one level further down).
  if (scope === null && shared.length === 0) {
    const decision = can(actor, 'knowledge:read', { type: 'knowledge_space', organizationId: ctx.organizationId })
    throw new PermissionError(decision.reason)
  }

  // A space has no team, so a team-scoped role reaches one only by being given it. That is
  // the honest answer rather than a predicate on a column that does not exist.
  const visible =
    scope === 'org'
      ? sql``
      : sql`AND (
            ${
              scope === 'department'
                ? sql`s.department_id = ANY(${actor.departmentIds}::uuid[])`
                : sql`false`
            }
            ${shared.length ? sql`OR s.id = ANY(${shared}::uuid[])` : sql``}
          )`

  return sql<SpaceView[]>`
    ${SELECT_SPACE(ctx)}
    WHERE s.organization_id = ${ctx.organizationId} AND s.deleted_at IS NULL
      ${visible}
    ORDER BY s.name`
}

export async function getSpace(ctx: TenantContext, actor: Actor, id: string): Promise<SpaceView> {
  const rows = await ctx.sql<SpaceView[]>`
    ${SELECT_SPACE(ctx)}
    WHERE s.organization_id = ${ctx.organizationId} AND s.id = ${id} AND s.deleted_at IS NULL`
  const space = rows[0]
  if (!space) throw new NotFoundError()

  const decision = can(actor, 'knowledge:read', {
    type: 'knowledge_space',
    id: space.id,
    organizationId: ctx.organizationId,
    departmentId: space.departmentId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  return space
}
