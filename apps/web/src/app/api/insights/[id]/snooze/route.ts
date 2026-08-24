import { NextResponse } from 'next/server'
import { z } from 'zod'
import { snoozeInsight, unsnoozeInsight } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Putting an insight off until a date (ADR 0083).
 *
 * Separate from the feedback route because a snooze is the one move that carries a moment, and
 * the database refuses `status = 'snoozed'` without one. The repository is the authority on how
 * far ahead it may be and on which states can be deferred at all.
 */
/**
 * `until` absent brings it back, the way the delegation route reclaims (ADR 0082). One field on
 * one route, because putting off and bringing back are the same act on the same pair of columns
 * and a second endpoint would be a second place the rules live.
 */
const Body = z.object({
  until: z.string().datetime().optional(),
  reason: z.string().max(200).optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  const body = parsed.data
  try {
    await withActor(session, (ctx, actor) =>
      body.until
        ? snoozeInsight(ctx, actor, {
            insightId: id,
            until: new Date(body.until),
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
          })
        : unsnoozeInsight(ctx, actor, id),
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
