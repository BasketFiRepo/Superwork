import { NextResponse } from 'next/server'
import { z } from 'zod'
import { classifyConversation } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Saying how far a thread of correspondence may travel (§4.3, ADR 0061).
 *
 * Lowering widens who can read it and cascades to every message already in the thread, so it
 * arrives as a `StepUpRequiredError` and becomes the password prompt at the caller. Raising only
 * narrows and never asks. The repository is the authority on that, on the reader's own ceiling
 * and on the reason being present — this layer only decides that the request is well formed.
 */
const Body = z.object({
  conversationId: z.string().uuid(),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
  reason: z.string().min(4).max(500),
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
      classifyConversation(ctx, actor, {
        conversationId: body.conversationId,
        sensitivity: body.sensitivity,
        reason: body.reason,
      }),
    )
    return NextResponse.json({ conversation })
  } catch (error) {
    return errorResponse(error)
  }
}
