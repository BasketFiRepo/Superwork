import { withApiKey } from '@/lib/api-auth'
import { listRuns } from '@superwork/core'
import { startRun } from '@superwork/agent'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  return withApiKey(request, 'runs:read', async ({ ctx, key }) => {
    // A key sees the runs of the person it acts as, never the whole organization.
    const runs = await listRuns(ctx, {
      principalUserId: key.principalUserId,
      limit: Math.min(Number(url.searchParams.get('limit') ?? 25), 100),
    })
    return {
      data: runs.map((run) => ({
        id: run.id,
        request: run.request,
        mode: run.mode,
        status: run.status,
        costCents: run.costCents,
        createdAt: run.createdAt,
        undoneAt: run.undoneAt,
      })),
    }
  })
}

/**
 * POST /api/v1/runs — starts a run as the key's principal. It is capped at `assist`: an
 * API caller can have work proposed, never executed unattended (§22.2).
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  return withApiKey(request, 'runs:write', async ({ ctx }) => {
    const requestText = String(body.request ?? '')
    if (!requestText.trim()) throw new Error('Pass a `request` describing what you want.')
    const { runId, traceId } = await startRun(
      { organizationId: ctx.organizationId, userId: ctx.userId, timezone: ctx.timezone },
      { request: requestText, mode: 'assist', trigger: 'workflow', uiContext: { route: '/api/v1/runs', api: true } },
    )
    return { data: { id: runId, traceId, mode: 'assist', status: 'queued' } }
  })
}
