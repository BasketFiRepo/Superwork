import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setDecisionConfirmation } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Standing behind a decision, or taking that back (ADR 0065).
 *
 * The repository is the authority on who may — somebody who was in the meeting, or who has a
 * say over the project — and on a withdrawal needing a reason. This layer only decides that
 * the request is well formed.
 */
const Body = z.object({
  decisionId: z.string().uuid(),
  confirmed: z.boolean(),
  reason: z.string().max(500).optional(),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  const body = parsed.data
  try {
    const decision = await withActor(session, (ctx, actor) =>
      setDecisionConfirmation(ctx, actor, {
        decisionId: body.decisionId,
        confirmed: body.confirmed,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      }),
    )
    return NextResponse.json({ decision })
  } catch (error) {
    return errorResponse(error)
  }
}
