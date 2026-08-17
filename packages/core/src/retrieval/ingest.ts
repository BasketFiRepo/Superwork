import { createHash } from 'node:crypto'
import type { Sensitivity, TenantContext } from '@superwork/db'
import { chunkDocument } from './chunk.js'
import { classifyContent, detectInjection, highestSeverity } from './classify.js'
import { embeddingProvider, toVectorLiteral } from './embed.js'
import { writeActivity } from '../audit.js'

/**
 * Ingestion pipeline (§7.1):
 *   Fetch → Parse → Normalize → Classify → Chunk → Enrich → Embed → Index → Verify
 *
 * Every stage is observable: the document row carries its index status and any error,
 * so a failed ingestion is visible in the UI rather than being a silent gap in memory.
 */

export interface IngestInput {
  documentId: string
  /** Already-parsed markdown. Binary parsing lives behind the StorageProvider. */
  body: string
  title: string
  docType?: string
  companyId?: string | null
  projectId?: string | null
  spaceId?: string | null
  ownerId?: string | null
  departmentId?: string | null
  sensitivityHint?: Sensitivity
  effectiveFrom?: string | null
  /**
   * The day it stops applying. Expired passages stay findable and stop being authoritative:
   * "what did the old contract say" is a real question (ADR 0042).
   */
  effectiveTo?: string | null
  /** Content arriving from outside the organization is scanned before indexing. */
  untrusted?: boolean
}

export interface IngestResult {
  documentId: string
  versionId: string
  chunks: number
  sensitivity: Sensitivity
  status: 'indexed' | 'quarantined' | 'failed'
  quarantineReason?: string
  verification: { sampled: number; answerable: number; warnings: string[] }
}

/** Strips signatures, legal footers and quoted reply chains before chunking (§7.1). */
export function normalize(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/^-{2,}\s*$\n(?:[\s\S]*?(?:regards|sincerely|sent from my)[\s\S]*)$/gim, '')
    .replace(/^\s*On .+ wrote:\s*$[\s\S]*/gim, '')
    .replace(/^(>.*\n?)+/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

/**
 * Contextual header per chunk (§7.1 Enrich). Built deterministically from the document's
 * own structure rather than a model call, so ingestion never depends on AI availability
 * and the header is identical on every re-index.
 *
 * **This text is embedded**, which is why administrative metadata stays out of it. The header
 * had a branch for `effective_from` from Phase 1 and no caller ever passed one, so it had never
 * run; the moment terms were seeded onto the Halden agreement and its amendment, the dates
 * entered the vector, diluted it, and pushed the amendment out of retrieval — the supersession
 * eval failed, which is exactly what that fixture is for. A term is a fact retrieval reads from
 * a column, not a phrase that belongs in an embedding (ADR 0042).
 */
function contextHeader(input: { title: string; docType: string; headingPath: string }): string {
  const parts = [`This excerpt is from "${input.title}"`]
  if (input.docType && input.docType !== 'document') parts.push(`a ${input.docType.replace(/_/g, ' ')}`)
  if (input.headingPath) parts.push(`section: ${input.headingPath}`)
  return `${parts.join(', ')}.`
}

export async function ingestDocument(ctx: TenantContext, input: IngestInput): Promise<IngestResult> {
  const sql = ctx.sql
  await sql`
    UPDATE documents SET index_status = 'processing', index_error = NULL
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.documentId}`

  try {
    const normalized = normalize(input.body)
    const contentHash = createHash('sha256').update(normalized).digest('hex')

    // ---- Injection scan before anything reaches the index -------------------
    const findings = input.untrusted ? detectInjection(normalized) : []
    const severity = highestSeverity(findings)
    if (severity === 'high') {
      const reason = `Instructions aimed at the AI were found in this content (${findings.map((f) => f.pattern).join(', ')}). It is quarantined from retrieval until a person reviews it.`
      await sql`
        UPDATE documents
        SET index_status = 'quarantined', quarantine_reason = ${reason}, indexed_at = now()
        WHERE organization_id = ${ctx.organizationId} AND id = ${input.documentId}`
      await writeActivity(ctx, {
        actorType: 'system',
        actorLabel: 'Superwork',
        verb: 'quarantined',
        entityType: 'document',
        entityId: input.documentId,
        entityLabel: input.title,
        summary: `Quarantined "${input.title}" — suspicious instructions detected in the content.`,
        metadata: { findings },
      })
      return {
        documentId: input.documentId,
        versionId: '',
        chunks: 0,
        sensitivity: 'internal',
        status: 'quarantined',
        quarantineReason: reason,
        verification: { sampled: 0, answerable: 0, warnings: [reason] },
      }
    }

    // ---- Classify -----------------------------------------------------------
    const classification = classifyContent(normalized, input.sensitivityHint ?? 'internal')

    // ---- Version ------------------------------------------------------------
    const [nextVersion] = await sql<{ next_ordinal: number }[]>`
      SELECT coalesce(max(ordinal), 0) + 1 AS next_ordinal
      FROM document_versions
      WHERE organization_id = ${ctx.organizationId} AND document_id = ${input.documentId}`
    const ordinal = nextVersion?.next_ordinal ?? 1

    const [previous] = await sql<{ id: string }[]>`
      SELECT id FROM document_versions
      WHERE organization_id = ${ctx.organizationId} AND document_id = ${input.documentId}
      ORDER BY ordinal DESC LIMIT 1`

    const [version] = await sql<{ id: string }[]>`
      INSERT INTO document_versions (
        organization_id, document_id, ordinal, body, content_hash, supersedes_version_id, created_by
      ) VALUES (
        ${ctx.organizationId}, ${input.documentId}, ${ordinal}, ${normalized}, ${contentHash},
        ${previous?.id ?? null}, ${ctx.userId}
      ) RETURNING id`
    const versionId = version!.id

    // Older versions stay retrievable but are down-ranked and labelled (§7.3).
    if (previous) {
      await sql`
        UPDATE document_chunks SET is_superseded = true
        WHERE organization_id = ${ctx.organizationId} AND version_id = ${previous.id}`
    }

    // ---- Chunk, enrich, embed, index ---------------------------------------
    const chunks = chunkDocument(normalized)
    const docType = input.docType ?? 'document'
    const enriched = chunks.map((chunk) => ({
      ...chunk,
      contextHeader: contextHeader({ title: input.title, docType, headingPath: chunk.headingPath }),
    }))

    const vectors = await embeddingProvider().embed(
      enriched.map((c) => `${c.contextHeader}\n${c.headingPath}\n${c.content}`),
    )

    for (const [i, chunk] of enriched.entries()) {
      const chunkClass = classifyContent(chunk.content, classification.sensitivity)
      await sql`
        INSERT INTO document_chunks (
          organization_id, document_id, version_id, ordinal, heading_path, anchor, content,
          context_header, token_count, sensitivity, effective_from, effective_to, embedding, created_by
        ) VALUES (
          ${ctx.organizationId}, ${input.documentId}, ${versionId}, ${chunk.ordinal},
          ${chunk.headingPath}, ${chunk.anchor}, ${chunk.content}, ${chunk.contextHeader},
          ${chunk.tokenCount}, ${chunkClass.sensitivity},
          ${input.effectiveFrom ?? null}, ${input.effectiveTo ?? null},
          ${toVectorLiteral(vectors[i] ?? [])}::vector, ${ctx.userId}
        )`
    }

    // ---- Verify -------------------------------------------------------------
    const verification = await verifyIndex(ctx, input.documentId, enriched)

    await sql`
      UPDATE documents SET
        index_status = 'indexed',
        indexed_at = now(),
        index_error = ${verification.warnings.length ? verification.warnings.join(' ') : null},
        current_version_id = ${versionId},
        content_hash = ${contentHash},
        sensitivity = ${classification.sensitivity},
        doc_type = ${docType},
        effective_from = coalesce(${input.effectiveFrom ?? null}::date, effective_from),
        effective_to = coalesce(${input.effectiveTo ?? null}::date, effective_to),
        -- Filing is kept unless this call restates it. These were assignments, so a
        -- caller that only asked for indexing silently unfiled the document: the seed
        -- inserted every document into a knowledge space and the very next statement set
        -- space_id back to NULL, which is why the spaces table looked disconnected from
        -- everything. Re-indexing is not a reason to forget where something lives.
        company_id = coalesce(${input.companyId ?? null}, company_id),
        project_id = coalesce(${input.projectId ?? null}, project_id),
        space_id = coalesce(${input.spaceId ?? null}, space_id),
        owner_id = coalesce(${input.ownerId ?? null}, owner_id),
        department_id = coalesce(${input.departmentId ?? null}, department_id),
        quarantine_reason = NULL
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.documentId}`

    return {
      documentId: input.documentId,
      versionId,
      chunks: enriched.length,
      sensitivity: classification.sensitivity,
      status: 'indexed',
      verification,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await sql`
      UPDATE documents SET index_status = 'failed', index_error = ${message}
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.documentId}`
    throw error
  }
}

/**
 * Post-index self-check (§7.1 Verify): every chunk must be retrievable by its own
 * distinctive terms. Failures raise a warning visible on the document rather than
 * leaving a silent hole in company memory.
 */
async function verifyIndex(
  ctx: TenantContext,
  documentId: string,
  chunks: { ordinal: number; content: string; headingPath: string }[],
): Promise<{ sampled: number; answerable: number; warnings: string[] }> {
  const sample = chunks.filter((_, i) => i % Math.max(1, Math.floor(chunks.length / 3)) === 0).slice(0, 3)
  const warnings: string[] = []
  let answerable = 0

  for (const chunk of sample) {
    const probe = chunk.content.split(/\s+/).filter((w) => w.length > 5).slice(0, 6).join(' ')
    if (!probe) {
      answerable += 1
      continue
    }
    const [hit] = await ctx.sql<{ hits: number }[]>`
      SELECT count(*)::int AS hits FROM document_chunks
      WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}
        AND tsv @@ plainto_tsquery('english', ${probe})`
    if ((hit?.hits ?? 0) > 0) answerable += 1
    else warnings.push(`Section "${chunk.headingPath || `#${chunk.ordinal}`}" may not be findable by search.`)
  }

  return { sampled: sample.length, answerable, warnings }
}

/**
 * Deleting a document must delete its chunks, embeddings and derived memories —
 * otherwise you have a compliance hole and a hallucination source (§25.13).
 */
export async function purgeDocument(ctx: TenantContext, documentId: string): Promise<void> {
  const sql = ctx.sql
  await sql`DELETE FROM document_chunks WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}`
  // The FK cascades, but the guarantee should not depend on a schema detail written two
  // migrations away: a purged document leaves no record that it was ever indexed.
  await sql`DELETE FROM ingestion_jobs WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}`
  await sql`DELETE FROM document_versions WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}`
  await sql`
    UPDATE memory_facts SET state = 'forgotten', deleted_at = now()
    WHERE organization_id = ${ctx.organizationId}
      AND source_citation->>'documentId' = ${documentId}`
  await sql`
    DELETE FROM citations WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}`
  await sql`
    DELETE FROM links WHERE organization_id = ${ctx.organizationId}
      AND ((from_type = 'document' AND from_id = ${documentId}) OR (to_type = 'document' AND to_id = ${documentId}))`
  await sql`DELETE FROM documents WHERE organization_id = ${ctx.organizationId} AND id = ${documentId}`
}
