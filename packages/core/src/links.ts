import { asJson, type LinkRelation, type TenantContext } from '@superwork/db'

/**
 * The polymorphic edge table (§3.4). Every agent-created entity carries a
 * `derived_from` link back to its source, which is what makes "why does this
 * task exist?" answerable in one click.
 */

export interface LinkRef {
  type: string
  id: string
}

export async function link(
  ctx: TenantContext,
  from: LinkRef,
  to: LinkRef,
  relation: LinkRelation = 'relates_to',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await ctx.sql`
    INSERT INTO links (organization_id, from_type, from_id, to_type, to_id, relation, metadata, created_by)
    VALUES (${ctx.organizationId}, ${from.type}, ${from.id}, ${to.type}, ${to.id}, ${relation},
            ${ctx.sql.json(asJson(metadata))}, ${ctx.userId})
    ON CONFLICT DO NOTHING`
}

export interface LinkedEntity {
  type: string
  id: string
  relation: LinkRelation
  direction: 'outgoing' | 'incoming'
  metadata: Record<string, unknown>
}

export async function linksFor(ctx: TenantContext, ref: LinkRef): Promise<LinkedEntity[]> {
  const rows = await ctx.sql<
    { type: string; id: string; relation: LinkRelation; direction: string; metadata: Record<string, unknown> }[]
  >`
    SELECT to_type AS type, to_id AS id, relation, 'outgoing' AS direction, metadata
    FROM links
    WHERE organization_id = ${ctx.organizationId} AND from_type = ${ref.type} AND from_id = ${ref.id}
      AND deleted_at IS NULL
    UNION ALL
    SELECT from_type AS type, from_id AS id, relation, 'incoming' AS direction, metadata
    FROM links
    WHERE organization_id = ${ctx.organizationId} AND to_type = ${ref.type} AND to_id = ${ref.id}
      AND deleted_at IS NULL`
  return rows.map((r) => ({ ...r, direction: r.direction as 'outgoing' | 'incoming' }))
}

/** The provenance chain: what this entity was derived from, and by which run. */
export async function provenanceFor(ctx: TenantContext, ref: LinkRef): Promise<LinkedEntity[]> {
  const all = await linksFor(ctx, ref)
  return all.filter((l) => l.relation === 'derived_from' && l.direction === 'outgoing')
}
