import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ingestionBacklog, requestReindex } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Asking for a document to be indexed again queues the work; it does not do it here. The
 * whole point of the queue is that indexing survives the request that asked for it (§7.1).
 */
const Body = z.object({
  action: z.literal('reindex'),
  documentId: z.string().uuid(),
  reason: z.string().max(300).optional(),
})

export async function GET() {
  const session = await requireSession()
  try {
    const backlog = await withActor(session, (ctx, actor) => ingestionBacklog(ctx, actor))
    return NextResponse.json({ backlog })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  const body = parsed.data
  try {
    const jobs = await withActor(session, (ctx, actor) =>
      requestReindex(ctx, actor, { documentId: body.documentId, reason: body.reason }),
    )
    return NextResponse.json({ jobs })
  } catch (error) {
    return errorResponse(error)
  }
}
