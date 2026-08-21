import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assignConversation } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Handing a thread to somebody, or taking it back (ADR 0063).
 *
 * `assigneeId: null` unassigns. The repository is the authority on who may do it, on the person
 * being a member of this organization, and on their clearance reaching the thread — this layer
 * only decides that the request is well formed.
 */
const Body = z.object({
  conversationId: z.string().uuid(),
  assigneeId: z.string().uuid().nullable(),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  const body = parsed.data
  try {
    const conversation = await withActor(session, (ctx, actor) =>
      assignConversation(ctx, actor, {
        conversationId: body.conversationId,
        assigneeId: body.assigneeId,
      }),
    )
    return NextResponse.json({ conversation })
  } catch (error) {
    return errorResponse(error)
  }
}
