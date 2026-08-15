import type { IndexStatus, Sensitivity, TenantContext } from '@superwork/db'
import { can, grantedScope, sharedObjectIds, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { ingestDocument, purgeDocument, type IngestResult } from '../retrieval/ingest.js'
import { holdsCoveringDocument } from '../legal-hold.js'

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
  teamId: string | null
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
         -- Declared on DocumentView and never selected, so it arrived undefined: the
         -- team-scoped list matched on d.team_id and then getDocument passed an empty
         -- teamIds and refused the very row the list had just shown.
         d.team_id AS "teamId",
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
  // Which documents may this actor consider, rather than "may they read all of them".
  const scope = grantedScope(actor, 'document:read', 'document')
  if (scope === null) {
    const decision = can(actor, 'document:read', { type: 'document', organizationId: ctx.organizationId })
    throw new PermissionError(decision.reason)
  }
  const sql = ctx.sql
  const shared = sharedObjectIds(actor, 'document')
  const visible =
    scope === 'org'
      ? sql``
      : sql`AND (
            ${
              scope === 'department'
                ? sql`d.department_id = ANY(${actor.departmentIds}::uuid[])`
                : scope === 'team'
                  ? sql`d.team_id = ANY(${actor.teamIds}::uuid[])`
                  : sql`d.owner_id = ${actor.userId}`
            }
            ${shared.length ? sql`OR d.id = ANY(${shared}::uuid[])` : sql``}
          )`
  return sql<DocumentView[]>`
    ${SELECT_DOC(ctx)}
    WHERE d.organization_id = ${ctx.organizationId} AND d.deleted_at IS NULL
      ${visible}
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
    teamIds: doc.teamId ? [doc.teamId] : [],
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

/**
 * Deleting a document, reachably (§25.13).
 *
 * `purgeDocument` — which removes the chunks, the versions, the citations, the links, and
 * marks the memories derived from it forgotten — has existed since Phase 1 and was called
 * by nothing. The anti-pattern it exists to prevent ("deleting a document must delete
 * chunks, embeddings and derived memories, otherwise you have a compliance hole and a
 * hallucination source") was therefore satisfied only in principle: there was no way to
 * delete a document at all.
 *
 * This is that way. Permission first, the purge second, the audit last — and the audit
 * carries the counts, because "it was deleted" and "everything derived from it went with
 * it" are different claims and only the second one matters here.
 */
export async function deleteDocument(
  ctx: TenantContext,
  actor: Actor,
  input: { documentId: string; reason: string },
): Promise<{ title: string; chunks: number; citations: number; memories: number }> {
  const document = await getDocument(ctx, actor, input.documentId)
  const decision = can(actor, 'document:delete', {
    type: 'document',
    id: document.id,
    organizationId: ctx.organizationId,
    ownerId: document.ownerId,
    sensitivity: document.sensitivity,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why it is being deleted. It goes in the audit trail beside what was removed.')
  }

  // A live hold outranks any reason somebody can type here. Deleting a document inside a
  // matter is the textbook case of spoliation, so it is refused rather than warned about.
  const holds = await holdsCoveringDocument(ctx, input.documentId)
  if (holds.length > 0) {
    throw new ValidationError(
      `This document is preserved for “${holds[0]!.matter}” and cannot be deleted while that hold stands. ` +
        'Release the hold first, if the matter is closed.',
    )
  }

  // Counted before, because after the purge there is nothing left to count — and the
  // numbers are the evidence that the derived data went too.
  const [counts] = await ctx.sql<{ chunks: number; citations: number; memories: number }[]>`
    SELECT
      (SELECT count(*)::int FROM document_chunks
        WHERE organization_id = ${ctx.organizationId} AND document_id = ${input.documentId}) AS chunks,
      (SELECT count(*)::int FROM citations
        WHERE organization_id = ${ctx.organizationId} AND document_id = ${input.documentId}) AS citations,
      (SELECT count(*)::int FROM memory_facts
        WHERE organization_id = ${ctx.organizationId}
          AND source_citation->>'documentId' = ${input.documentId}
          AND state <> 'forgotten') AS memories`

  await purgeDocument(ctx, input.documentId)

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'document.deleted',
    entityType: 'document',
    entityId: input.documentId,
    before: { title: document.title, sensitivity: document.sensitivity },
    after: {
      reason: input.reason,
      chunksRemoved: counts?.chunks ?? 0,
      citationsRemoved: counts?.citations ?? 0,
      memoriesForgotten: counts?.memories ?? 0,
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'deleted',
    entityType: 'document',
    entityId: input.documentId,
    entityLabel: document.title,
    summary:
      `${actor.displayName} deleted "${document.title}" — ${counts?.chunks ?? 0} indexed passages and ` +
      `${counts?.memories ?? 0} derived memories went with it. ${input.reason}`,
  })

  return {
    title: document.title,
    chunks: counts?.chunks ?? 0,
    citations: counts?.citations ?? 0,
    memories: counts?.memories ?? 0,
  }
}
