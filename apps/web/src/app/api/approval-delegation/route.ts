import { NextResponse } from 'next/server'
import { z } from 'zod'
import { delegateApproval, reclaimApproval } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Handing an approval on, and taking it back (ADR 0082).
 *
 * The repository is the authority on all of it: that you could have decided it yourself, that
 * the person you are handing it to could have too, that it is not the requester, and that you
 * said why. This layer only decides the request is well formed.
 *
 * `toUserId` is absent to take one back rather than a separate route, because the two are the
 * same act on the same field and a second endpoint would be a second place the rules live.
 */
const Body = z.object({
  approvalId: z.string().uuid(),
  toUserId: z.string().uuid().optional(),
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
    const approval = await withActor(session, (ctx, actor) =>
      body.toUserId
        ? delegateApproval(ctx, actor, {
            approvalId: body.approvalId,
            toUserId: body.toUserId,
            reason: body.reason ?? '',
          })
        : reclaimApproval(ctx, actor, body.approvalId),
    )
    return NextResponse.json({ approval })
  } catch (error) {
    return errorResponse(error)
  }
}
