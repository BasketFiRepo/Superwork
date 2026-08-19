import { NextResponse } from 'next/server'
import { z } from 'zod'
import { listOutgoing, recallSend } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  action: z.literal('recall'),
  sendId: z.string().uuid(),
  reason: z.string().min(3).max(500),
})

export async function GET() {
  const session = await requireSession()
  try {
    const outgoing = await withActor(session, (ctx, actor) => listOutgoing(ctx, actor))
    return NextResponse.json({ outgoing })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Stopping a send before it goes (ADR 0054).
 *
 * The repository decides whether it is too late, because only the row can: the dispatcher claims
 * it before calling the provider, and whichever of the two updates finds no row is the one that
 * lost.
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  try {
    const outgoing = await withActor(session, (ctx, actor) =>
      recallSend(ctx, actor, { sendId: parsed.data.sendId, reason: parsed.data.reason }),
    )
    return NextResponse.json({ outgoing })
  } catch (error) {
    return errorResponse(error)
  }
}
