import type { IndexStatus, Sensitivity, TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { ingestDocument, type IngestResult } from '../retrieval/ingest.js'

export interface DocumentView {
  id: string
  title: string
  docType: string
  sensitivity: Sensitivity
  indexStatus: IndexStatus
  indexError: string | null
  quarantineReason: string | null
  citationCount: number
  companyId: string | null
  companyName: string | null
  ownerId: string | null
  ownerName: string | null
  departmentId: string | null
  chunkCount: number
  createdAt: Date
  updatedAt: Date
}

const SELECT_DOC = (ctx: TenantContext) => ctx.sql`
  SELECT d.id, d.title, d.doc_type AS "docType", d.sensitivity,
         d.index_status AS "indexStatus", d.index_error AS "indexError",
         d.quarantine_reason AS "quarantineReason", d.citation_count AS "citationCount",
         d.company_id AS "companyId", c.name AS "companyName",
         d.owner_id AS "ownerId", u.name AS "ownerName", d.department_id AS "departmentId",
         (SELECT count(*)::int FROM document_chunks ch
           WHERE ch.document_id = d.id AND ch.version_id = d.current_version_id) AS "chunkCount",
         d.created_at AS "createdAt", d.updated_at AS "updatedAt"
  FROM documents d
  LEFT JOIN companies c ON c.id = d.company_id
  LEFT JOIN users u ON u.id = d.owner_id`

export async function listDocuments(
  ctx: TenantContext,
  actor: Actor,
  filter: { search?: string; companyId?: string; limit?: number } = {},
): Promise<DocumentView[]> {
  const decision = can(actor, 'document:read', { type: 'document', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)
  const sql = ctx.sql
  return sql<DocumentView[]>`
    ${SELECT_DOC(ctx)}
    WHERE d.organization_id = ${ctx.organizationId} AND d.deleted_at IS NULL
      ${filter.search ? sql`AND d.title ILIKE ${'%' + filter.search + '%'}` : sql``}
      ${filter.companyId ? sql`AND d.company_id = ${filter.companyId}` : sql``}
    ORDER BY d.created_at DESC
    LIMIT ${Math.min(filter.limit ?? 100, 200)}`
}

export async function getDocument(ctx: TenantContext, actor: Actor, id: string): Promise<DocumentView> {
  const rows = await ctx.sql<DocumentView[]>`
    ${SELECT_DOC(ctx)}
    WHERE d.organization_id = ${ctx.organizationId} AND d.id = ${id} AND d.deleted_at IS NULL`
  const doc = rows[0]
  if (!doc) throw new NotFoundError()

  const decision = can(actor, 'document:read', {
    type: 'document',
    id: doc.id,
    organizationId: ctx.organizationId,
    ownerId: doc.ownerId,
    departmentId: doc.departmentId,
    sensitivity: doc.sensitivity,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  return doc
}

export async function getDocumentBody(
  ctx: TenantContext,
  actor: Actor,
  id: string,
): Promise<{ document: DocumentView; body: string }> {
  const document = await getDocument(ctx, actor, id)
  const [row] = await ctx.sql<{ body: string }[]>`
    SELECT dv.body FROM documents d
    JOIN document_versions dv ON dv.id = d.current_version_id
    WHERE d.organization_id = ${ctx.organizationId} AND d.id = ${id}`
  return { document, body: row?.body ?? '' }
}

export interface UploadInput {
  title: string
  body: string
  docType?: string
  companyId?: string | null
  projectId?: string | null
  spaceId?: string | null
  departmentId?: string | null
  sensitivityHint?: Sensitivity
  untrusted?: boolean
  source?: string
}

/** Upload + ingest as one operation: a document that is not indexed is not memory. */
export async function uploadDocument(
  ctx: TenantContext,
  actor: Actor,
  input: UploadInput,
): Promise<{ document: DocumentView; ingest: IngestResult }> {
  const decision = can(actor, 'document:create', {
    type: 'document',
    organizationId: ctx.organizationId,
    departmentId: input.departmentId ?? null,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const [created] = await ctx.sql<{ id: string }[]>`
    INSERT INTO documents (
      organization_id, title, doc_type, source, company_id, project_id, space_id,
      department_id, owner_id, sensitivity, index_status, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.title}, ${input.docType ?? 'document'},
      ${input.source ?? 'upload'}, ${input.companyId ?? null}, ${input.projectId ?? null},
      ${input.spaceId ?? null}, ${input.departmentId ?? null}, ${actor.userId},
      ${input.sensitivityHint ?? 'internal'}, 'pending', ${ctx.userId}
    ) RETURNING id`

  const documentId = created!.id

  const ingest = await ingestDocument(ctx, {
    documentId,
    body: input.body,
    title: input.title,
    docType: input.docType ?? 'document',
    companyId: input.companyId ?? null,
    projectId: input.projectId ?? null,
    spaceId: input.spaceId ?? null,
    ownerId: actor.userId,
    departmentId: input.departmentId ?? null,
    sensitivityHint: input.sensitivityHint ?? 'internal',
    untrusted: input.untrusted ?? false,
  })

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'uploaded',
    entityType: 'document',
    entityId: documentId,
    entityLabel: input.title,
    summary:
      ingest.status === 'indexed'
        ? `Added "${input.title}" to company memory (${ingest.chunks} sections indexed)`
        : `Added "${input.title}" — ${ingest.status}`,
  })
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'document.upload',
    entityType: 'document',
    entityId: documentId,
    after: { title: input.title, sensitivity: ingest.sensitivity, index_status: ingest.status },
  })

  return { document: await getDocument(ctx, actor, documentId), ingest }
}

/** Knowledge health panel (§7.6). */
export async function knowledgeHealth(ctx: TenantContext): Promise<{
  byStatus: { status: IndexStatus; count: number }[]
  totalChunks: number
  topUnanswered: { query: string; occurrences: number }[]
  mostCited: { id: string; title: string; citationCount: number }[]
}> {
  const sql = ctx.sql
  const byStatus = await sql<{ status: IndexStatus; count: number }[]>`
    SELECT index_status AS status, count(*)::int AS count
    FROM documents WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
    GROUP BY index_status`
  const [chunks] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM document_chunks WHERE organization_id = ${ctx.organizationId}`
  const topUnanswered = await sql<{ query: string; occurrences: number }[]>`
    SELECT query, occurrences FROM unanswered_queries
    WHERE organization_id = ${ctx.organizationId}
    ORDER BY occurrences DESC, last_seen_at DESC LIMIT 10`
  const mostCited = await sql<{ id: string; title: string; citationCount: number }[]>`
    SELECT id, title, citation_count AS "citationCount" FROM documents
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND citation_count > 0
    ORDER BY citation_count DESC LIMIT 10`
  return { byStatus, totalChunks: chunks?.count ?? 0, topUnanswered, mostCited }
}
