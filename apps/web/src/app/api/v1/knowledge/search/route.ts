import { withApiKey } from '@/lib/api-auth'
import { hybridSearch } from '@superwork/core'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/knowledge/search?q= — the same retrieval the assistant uses, with the same
 * ACL predicate inside the query. A key can never read a passage its principal cannot.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const query = url.searchParams.get('q') ?? ''
  return withApiKey(request, 'knowledge:read', async ({ ctx, actor }) => {
    if (!query.trim()) throw new Error('Pass a query as ?q=')
    const result = await hybridSearch(ctx, actor, query, {
      topK: Math.min(Number(url.searchParams.get('limit') ?? 8), 25),
    })
    return {
      data: result.chunks.map((chunk) => ({
        documentId: chunk.documentId,
        documentTitle: chunk.documentTitle,
        anchor: chunk.anchor,
        headingPath: chunk.headingPath,
        content: chunk.content,
        score: chunk.rerankScore,
        isSuperseded: chunk.isSuperseded,
      })),
      noAnswer: result.noAnswer,
    }
  })
}
