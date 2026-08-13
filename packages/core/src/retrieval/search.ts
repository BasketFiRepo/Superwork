import type { Sensitivity, TenantContext } from '@superwork/db'
import { ROLE_MAX_SENSITIVITY, SENSITIVITY_RANK, type Actor } from '@superwork/auth'
import { embeddingProvider, tokenize, toVectorLiteral } from './embed.js'

/**
 * Hybrid retrieval (§7.3).
 *
 * Keyword (tsvector) and dense (pgvector) candidates are fused with Reciprocal Rank
 * Fusion, then reranked. The ACL predicate lives *inside* both SQL queries — a chunk the
 * actor may not read is never fetched, so it cannot leak into a prompt, a log, or a
 * latency-based side channel.
 */

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  documentTitle: string
  docType: string
  anchor: string
  headingPath: string
  content: string
  contextHeader: string
  sensitivity: Sensitivity
  isSuperseded: boolean
  companyId: string | null
  updatedAt: Date
  keywordRank: number | null
  vectorRank: number | null
  fusedScore: number
  rerankScore: number
}

export interface SearchOptions {
  topK?: number
  /** Entity-anchored retrieval: hard-filter to a company/project before broadening. */
  companyId?: string | null
  projectId?: string | null
  docTypes?: string[]
  includeSuperseded?: boolean
  /** Below this reranked score the engine reports "no answer" rather than padding. */
  minScore?: number
}

export interface SearchResult {
  chunks: RetrievedChunk[]
  /** True when nothing cleared the threshold — the caller must say so, not guess (§7.3). */
  noAnswer: boolean
  query: string
  expandedQuery: string
  topScore: number
  scopeNote: string
}

const RRF_K = 60

/** Query transformation: expand org acronyms and strip conversational filler (§7.3). */
export function transformQuery(query: string, glossary: { term: string; meaning: string }[] = []): string {
  let expanded = query.trim()
  for (const entry of glossary) {
    const re = new RegExp(`\\b${entry.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    if (re.test(expanded)) expanded = `${expanded} ${entry.meaning}`
  }
  return expanded
}

export async function hybridSearch(
  ctx: TenantContext,
  actor: Actor,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const sql = ctx.sql
  const topK = Math.min(options.topK ?? 12, 30)
  const candidates = Math.max(topK * 4, 40)
  const ceiling: Sensitivity = actor.agent
    ? lowest(ROLE_MAX_SENSITIVITY[actor.role], actor.agent.maxSensitivity)
    : ROLE_MAX_SENSITIVITY[actor.role]
  const maxRank = SENSITIVITY_RANK[ceiling]

  const [org] = await sql<{ glossary: { term: string; meaning: string }[] }[]>`
    SELECT glossary FROM organizations WHERE id = ${ctx.organizationId}`
  const expanded = transformQuery(query, org?.glossary ?? [])
  const vector = toVectorLiteral((await embeddingProvider().embed([expanded]))[0] ?? [])

  // The ACL predicate, applied identically to both retrieval arms.
  const acl = sql`
    d.deleted_at IS NULL
    AND d.index_status = 'indexed'
    AND d.quarantine_reason IS NULL
    AND ch.deleted_at IS NULL
    AND CASE ch.sensitivity
          WHEN 'public' THEN 0 WHEN 'internal' THEN 1
          WHEN 'confidential' THEN 2 ELSE 3 END <= ${maxRank}
    AND (
      NOT EXISTS (
        SELECT 1 FROM document_permissions dp
        WHERE dp.document_id = d.id AND dp.deleted_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM document_permissions dp
        WHERE dp.document_id = d.id AND dp.deleted_at IS NULL
          AND (
            (dp.subject_type = 'user' AND dp.subject_id = ${actor.userId})
            OR (dp.subject_type = 'department' AND dp.subject_id = ANY(${actor.departmentIds}::uuid[]))
            OR (dp.subject_type = 'team' AND dp.subject_id = ANY(${actor.teamIds}::uuid[]))
            OR (dp.subject_type = 'role' AND dp.subject_role = ${actor.role}::sw_role)
          )
      )
    )
    ${options.companyId ? sql`AND d.company_id = ${options.companyId}` : sql``}
    ${options.projectId ? sql`AND d.project_id = ${options.projectId}` : sql``}
    ${options.docTypes?.length ? sql`AND d.doc_type = ANY(${options.docTypes})` : sql``}
    ${options.includeSuperseded ? sql`` : sql`AND ch.is_superseded = false`}`

  const rows = await sql<
    {
      chunk_id: string
      document_id: string
      document_title: string
      doc_type: string
      anchor: string
      heading_path: string
      content: string
      context_header: string
      sensitivity: Sensitivity
      is_superseded: boolean
      company_id: string | null
      updated_at: Date
      keyword_rank: number | null
      vector_rank: number | null
    }[]
  >`
    WITH keyword AS (
      SELECT ch.id AS chunk_id,
             row_number() OVER (ORDER BY ts_rank_cd(ch.tsv, plainto_tsquery('english', ${expanded})) DESC) AS rank
      FROM document_chunks ch
      JOIN documents d ON d.id = ch.document_id
      WHERE ch.organization_id = ${ctx.organizationId}
        AND ch.tsv @@ plainto_tsquery('english', ${expanded})
        AND ${acl}
      LIMIT ${candidates}
    ),
    dense AS (
      SELECT ch.id AS chunk_id,
             row_number() OVER (ORDER BY ch.embedding <=> ${vector}::vector) AS rank
      FROM document_chunks ch
      JOIN documents d ON d.id = ch.document_id
      WHERE ch.organization_id = ${ctx.organizationId}
        AND ch.embedding IS NOT NULL
        AND ${acl}
      ORDER BY ch.embedding <=> ${vector}::vector
      LIMIT ${candidates}
    ),
    fused AS (
      SELECT coalesce(k.chunk_id, v.chunk_id) AS chunk_id, k.rank AS keyword_rank, v.rank AS vector_rank
      FROM keyword k FULL OUTER JOIN dense v ON v.chunk_id = k.chunk_id
    )
    SELECT ch.id AS chunk_id, ch.document_id, d.title AS document_title, d.doc_type,
           ch.anchor, ch.heading_path, ch.content, ch.context_header, ch.sensitivity,
           ch.is_superseded, d.company_id, ch.updated_at,
           f.keyword_rank, f.vector_rank
    FROM fused f
    JOIN document_chunks ch ON ch.id = f.chunk_id
    JOIN documents d ON d.id = ch.document_id
    WHERE ch.organization_id = ${ctx.organizationId}
    LIMIT ${candidates}`

  const queryTerms = new Set(tokenize(expanded))
  const now = Date.now()

  const scored: RetrievedChunk[] = rows.map((r) => {
    const fused =
      (r.keyword_rank ? 1 / (RRF_K + Number(r.keyword_rank)) : 0) +
      (r.vector_rank ? 1 / (RRF_K + Number(r.vector_rank)) : 0)

    // Rerank: lexical coverage of the query, plus recency and authority weighting.
    const chunkTerms = new Set(tokenize(`${r.heading_path} ${r.content}`))
    let overlap = 0
    for (const term of queryTerms) if (chunkTerms.has(term)) overlap += 1
    const coverage = queryTerms.size ? overlap / queryTerms.size : 0

    const ageDays = Math.max(0, (now - new Date(r.updated_at).getTime()) / 86_400_000)
    const recency = 1 / (1 + ageDays / 365)
    const authority = r.is_superseded ? 0.35 : 1
    const headingBoost = tokenize(r.heading_path).some((t) => queryTerms.has(t)) ? 0.12 : 0

    const rerankScore = (0.55 * coverage + 0.3 * fused * RRF_K + 0.15 * recency + headingBoost) * authority

    return {
      chunkId: r.chunk_id,
      documentId: r.document_id,
      documentTitle: r.document_title,
      docType: r.doc_type,
      anchor: r.anchor,
      headingPath: r.heading_path,
      content: r.content,
      contextHeader: r.context_header,
      sensitivity: r.sensitivity,
      isSuperseded: r.is_superseded,
      companyId: r.company_id,
      updatedAt: new Date(r.updated_at),
      keywordRank: r.keyword_rank ? Number(r.keyword_rank) : null,
      vectorRank: r.vector_rank ? Number(r.vector_rank) : null,
      fusedScore: fused,
      rerankScore,
    }
  })

  scored.sort((a, b) => b.rerankScore - a.rerankScore)
  const top = scored.slice(0, topK)
  const topScore = top[0]?.rerankScore ?? 0
  const minScore = options.minScore ?? 0.12
  const noAnswer = top.length === 0 || topScore < minScore

  if (noAnswer) await recordUnansweredQuery(ctx, query, topScore)

  return {
    chunks: noAnswer ? [] : top,
    noAnswer,
    query,
    expandedQuery: expanded,
    topScore,
    scopeNote: options.companyId
      ? 'Scoped to this company before broadening.'
      : 'Searched across company memory you have access to.',
  }
}

function lowest(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[a] <= SENSITIVITY_RANK[b] ? a : b
}

/** Feeds the "top unanswered queries" panel — it tells the org what to document (§7.6). */
async function recordUnansweredQuery(ctx: TenantContext, query: string, topScore: number): Promise<void> {
  await ctx.sql`
    INSERT INTO unanswered_queries (organization_id, query, top_score, created_by)
    VALUES (${ctx.organizationId}, ${query}, ${topScore}, ${ctx.userId})
    ON CONFLICT (organization_id, lower(query))
    DO UPDATE SET occurrences = unanswered_queries.occurrences + 1, last_seen_at = now()`
}

/** Increments the "referenced by the AI N times" counter shown on each document (§12.7). */
export async function recordCitationUse(ctx: TenantContext, documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return
  await ctx.sql`
    UPDATE documents SET citation_count = citation_count + 1
    WHERE organization_id = ${ctx.organizationId} AND id = ANY(${documentIds}::uuid[])`
}
