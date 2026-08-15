import type { Sensitivity, TenantContext } from '@superwork/db'
import { can, grantedScope, sharedObjectIds, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeAudit } from '../audit.js'

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

/**
 * Making a shelf, renaming one, and putting one away (ADR 0036).
 *
 * ADR 0025 said it plainly and left it: *"Spaces are read, shared and filed into; they are
 * not yet authored."* Until now the only space any organization had was the one the seed
 * made, so "file this under…" offered exactly one answer.
 *
 * Creating one needs `knowledge:create` — the same permission as adding a document, because
 * a shelf with nothing on it changes nothing about who can read what. Renaming and archiving
 * need `knowledge:update`.
 */
function guardSpaceWrite(
  ctx: TenantContext,
  actor: Actor,
  verb: 'create' | 'update',
  departmentId?: string | null,
): void {
  // A shelf for one department is a departmental act, so the department travels with the
  // question: a manager holds `knowledge:*:department` and would otherwise be refused a
  // shelf for their own people. A shelf for the whole company needs an organization-wide
  // grant, which is the honest reading of "for the whole company".
  const decision = can(actor, `knowledge:${verb}`, {
    type: 'knowledge',
    organizationId: ctx.organizationId,
    departmentId: departmentId ?? null,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

/** A slug a link can carry, derived from the name and never from user input. */
function slugFor(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export async function createSpace(
  ctx: TenantContext,
  actor: Actor,
  input: {
    name: string
    description?: string | null
    defaultSensitivity?: Sensitivity
    departmentId?: string | null
  },
): Promise<SpaceView[]> {
  guardSpaceWrite(ctx, actor, 'create', input.departmentId)

  const name = input.name.trim()
  if (name.length < 2) throw new ValidationError('A space needs a name somebody would recognise.')
  const slug = slugFor(name)
  if (slug.length === 0) throw new ValidationError('That name has no letters or numbers in it.')

  // A space's default classification cannot exceed what the person creating it may read.
  // Otherwise somebody could open a shelf whose documents they are not cleared to see.
  const sensitivity = input.defaultSensitivity ?? 'internal'
  const readable = can(actor, 'knowledge:read', {
    type: 'knowledge',
    organizationId: ctx.organizationId,
    sensitivity,
  })
  if (!readable.allow) {
    throw new PermissionError(
      `${readable.reason} A space cannot default its documents to a classification you could not open yourself.`,
    )
  }

  const [clash] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM knowledge_spaces
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND (lower(btrim(name)) = lower(${name}) OR slug = ${slug})`
  if (clash) throw new ValidationError('There is already a space with that name.')

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO knowledge_spaces (
      organization_id, name, slug, description, default_sensitivity, department_id, created_by
    ) VALUES (
      ${ctx.organizationId}, ${name}, ${slug}, ${input.description?.trim() || null},
      ${sensitivity}::sw_sensitivity, ${input.departmentId ?? null}, ${ctx.userId}
    ) RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'space.created',
    entityType: 'knowledge_space',
    entityId: row!.id,
    after: { name, slug, defaultSensitivity: sensitivity },
  })

  return listSpaces(ctx, actor)
}

export async function updateSpace(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string; name?: string; description?: string | null; departmentId?: string | null },
): Promise<SpaceView[]> {
  const before = await getSpace(ctx, actor, input.id)
  guardSpaceWrite(ctx, actor, 'update', before.departmentId)

  const name = input.name?.trim() ?? before.name
  if (name.length < 2) throw new ValidationError('A space needs a name somebody would recognise.')

  const sql = ctx.sql
  await sql`
    UPDATE knowledge_spaces
    SET name = ${name},
        slug = ${slugFor(name)},
        description = ${input.description === undefined ? sql`description` : (input.description?.trim() || null)},
        department_id = ${input.departmentId === undefined ? sql`department_id` : input.departmentId},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'space.updated',
    entityType: 'knowledge_space',
    entityId: input.id,
    before: { name: before.name },
    after: { name },
  })

  return listSpaces(ctx, actor)
}

/**
 * Puts a shelf away.
 *
 * Refused while documents are still filed on it: they would keep a `space_id` pointing at
 * something no screen shows, and a share of the space would lend a read of documents nobody
 * can find the shelf for. Same rule as disbanding a team or archiving a department.
 */
export async function archiveSpace(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string; reason: string },
): Promise<SpaceView[]> {
  if (input.reason.trim().length < 4) throw new ValidationError('Say why it is going.')

  const space = await getSpace(ctx, actor, input.id)
  guardSpaceWrite(ctx, actor, 'update', space.departmentId)
  if (space.documentCount > 0) {
    throw new ValidationError(
      `${space.documentCount} document${space.documentCount === 1 ? ' is' : 's are'} still filed on “${space.name}”. ` +
        'Move them first: archiving it would leave them on a shelf nobody can see.',
    )
  }

  await ctx.sql`
    UPDATE knowledge_spaces SET deleted_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'space.archived',
    entityType: 'knowledge_space',
    entityId: input.id,
    before: { name: space.name },
    after: { reason: input.reason.trim() },
  })

  return listSpaces(ctx, actor)
}
