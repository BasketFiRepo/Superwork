import type { TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeAudit } from '../audit.js'

/**
 * Saved views (§17).
 *
 * `saved_views` has existed since migration 0002 and has never been read or written by
 * anything, including the seed. A list screen with five fixed filters and a search box is a
 * list screen that every person re-types their own question into, every day.
 *
 * **The query is validated, never trusted.** It is a `jsonb` blob, and a saved view is a
 * button somebody presses later: one that expanded into a filter the list does not
 * understand would quietly show the wrong rows, and one that carried an unexpected key
 * would be a filter written by whoever last edited the row. Only the keys this module knows
 * survive, and they are the ones the list actually accepts.
 *
 * A view is a saved *question*, not a grant. Applying one runs the same scope-aware read as
 * the screen it belongs to, so a shared view shows each person exactly what they could
 * already see — two people opening the same view can see different rows, and that is right.
 */

export type ViewEntity = 'task' | 'inbox'

/**
 * The filters a saved view may carry, which are exactly the ones the two lists accept.
 *
 * `filter` and `q` belong to the tasks list, `view` to the inbox. A view carrying the wrong
 * one for its entity is not an error — it is dropped, the same way an unknown key is.
 */
export interface ViewQuery {
  filter?: 'all' | 'mine' | 'overdue' | 'today' | 'blocked' | 'watching'
  q?: string
  view?: 'queue' | 'mine' | 'waiting' | 'snoozed' | 'archived'
}

export interface SavedViewView {
  id: string
  name: string
  entity: ViewEntity
  query: ViewQuery
  shared: boolean
  /** True when this is the reader's own — the only ones they may change. */
  mine: boolean
  ownerName: string | null
  createdAt: Date
}

const FILTERS = new Set(['all', 'mine', 'overdue', 'today', 'blocked', 'watching'])
const VIEWS = new Set(['queue', 'mine', 'waiting', 'snoozed', 'archived'])

/**
 * Keeps only what the list understands.
 *
 * Deliberately a whitelist rather than a schema check on the way in: the row can be edited
 * by a later migration, a backup restore or a support script, and the moment that matters is
 * the moment it is read.
 */
export function sanitizeQuery(raw: unknown): ViewQuery {
  const source = (raw ?? {}) as Record<string, unknown>
  const query: ViewQuery = {}
  if (typeof source['filter'] === 'string' && FILTERS.has(source['filter'])) {
    query.filter = source['filter'] as ViewQuery['filter']
  }
  if (typeof source['view'] === 'string' && VIEWS.has(source['view'])) {
    query.view = source['view'] as ViewQuery['view']
  }
  if (typeof source['q'] === 'string' && source['q'].trim().length > 0) {
    query.q = source['q'].trim().slice(0, 120)
  }
  return query
}

function guardRead(ctx: TenantContext, actor: Actor, entity: ViewEntity): void {
  // A view over a list you cannot open is a menu entry that leads to a refusal.
  const decision = can(actor, entity === 'task' ? 'task:read' : 'conversation:read', {
    type: entity === 'task' ? 'task' : 'conversation',
    organizationId: ctx.organizationId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

/** Your own views, and anything a colleague has shared with everybody. */
export async function listSavedViews(
  ctx: TenantContext,
  actor: Actor,
  entity: ViewEntity,
): Promise<SavedViewView[]> {
  guardRead(ctx, actor, entity)

  const rows = await ctx.sql<
    {
      id: string
      name: string
      entity: ViewEntity
      query: unknown
      shared: boolean
      userId: string
      ownerName: string | null
      createdAt: Date
    }[]
  >`
    SELECT v.id, v.name, v.entity, v.query, v.shared, v.user_id AS "userId",
           u.name AS "ownerName", v.created_at AS "createdAt"
    FROM saved_views v
    LEFT JOIN users u ON u.id = v.user_id
    WHERE v.organization_id = ${ctx.organizationId} AND v.deleted_at IS NULL
      AND v.entity = ${entity}
      AND (v.user_id = ${actor.userId} OR v.shared)
    ORDER BY v.shared, lower(v.name)`

  return rows.map(({ userId, query, ...row }) => ({
    ...row,
    query: sanitizeQuery(query),
    mine: userId === actor.userId,
  }))
}

export interface SaveViewInput {
  name: string
  entity: ViewEntity
  query: ViewQuery
  shared?: boolean
}

export async function saveView(
  ctx: TenantContext,
  actor: Actor,
  input: SaveViewInput,
): Promise<SavedViewView[]> {
  guardRead(ctx, actor, input.entity)

  const name = input.name.trim()
  if (name.length < 2) throw new ValidationError('A view needs a name you would recognise in a menu.')
  if (name.length > 60) throw new ValidationError('That name is longer than a menu entry should be.')

  const query = sanitizeQuery(input.query)
  if (Object.keys(query).length === 0) {
    throw new ValidationError(
      'That view has no question in it. Choose a filter or type a search first, then save what you are looking at.',
    )
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO saved_views (organization_id, user_id, name, entity, query, shared, created_by)
    VALUES (${ctx.organizationId}, ${actor.userId}, ${name}, ${input.entity},
            ${ctx.sql.json(asJson(query))}, ${input.shared ?? false}, ${ctx.userId})
    ON CONFLICT (organization_id, user_id, entity, lower(btrim(name))) WHERE deleted_at IS NULL
    DO UPDATE SET query = EXCLUDED.query, shared = EXCLUDED.shared, updated_at = now()
    RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'saved_view.saved',
    entityType: 'saved_view',
    entityId: row!.id,
    after: { name, entity: input.entity, query, shared: input.shared ?? false },
  })

  return listSavedViews(ctx, actor, input.entity)
}

/** Yours to remove, and nobody else's — a shared view belongs to whoever made it. */
export async function deleteSavedView(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string },
): Promise<SavedViewView[]> {
  const [view] = await ctx.sql<{ entity: ViewEntity; userId: string; name: string }[]>`
    SELECT entity, user_id AS "userId", name FROM saved_views
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL`
  if (!view) throw new NotFoundError()
  if (view.userId !== actor.userId) {
    throw new PermissionError(
      'That view belongs to somebody else. A shared view is theirs to change or remove — you can stop using it, which is not the same as deleting it for everybody.',
    )
  }

  await ctx.sql`
    UPDATE saved_views SET deleted_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'saved_view.deleted',
    entityType: 'saved_view',
    entityId: input.id,
    before: { name: view.name, entity: view.entity },
  })

  return listSavedViews(ctx, actor, view.entity)
}
