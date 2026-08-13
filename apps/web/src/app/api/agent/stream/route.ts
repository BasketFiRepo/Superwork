import { subscribe } from '@superwork/agent'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Server-sent events for the trace rail (§5.8). Structured step events, not just tokens,
 * so the rail can show real labels rather than a spinner.
 */
export async function GET(request: Request) {
  const session = await requireSession()
  const runId = new URL(request.url).searchParams.get('runId')
  if (!runId) return new Response('runId is required', { status: 400 })

  // The run must belong to this tenant. RLS makes a cross-tenant id simply absent.
  const owned = await withActor(session, async (ctx) => {
    const [row] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM agent_runs WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
    return !!row
  })
  if (!owned) return new Response('Not found', { status: 404 })

  const encoder = new TextEncoder()
  const controller = new AbortController()
  request.signal.addEventListener('abort', () => controller.abort())

  const stream = new ReadableStream({
    async start(streamController) {
      try {
        for await (const event of subscribe(runId, controller.signal)) {
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        }
      } catch {
        // Client disconnected. The run itself keeps going (§5.8).
      } finally {
        streamController.close()
      }
    },
    cancel() {
      controller.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
