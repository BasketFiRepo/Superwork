import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createFollowUp, listFollowUps, resolveFollowUp } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    conversationId: z.string().uuid().nullish(),
    companyId: z.string().uuid().nullish(),
    taskId: z.string().uuid().nullish(),
    ownerId: z.string().uuid().nullish(),
    dueOn: z.string().date(),
    reason: z.string().min(4).max(500),
  }),
  z.object({
    action: z.literal('resolve'),
    id: z.string().uuid(),
    resolution: z.enum(['done', 'cancelled']),
    note: z.string().max(500).optional(),
  }),
])

export async function GET(request: Request) {
  const session = await requireSession()
  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId') ?? undefined
  try {
    const followUps = await withActor(session, (ctx, actor) =>
      listFollowUps(ctx, actor, { conversationId, openOnly: url.searchParams.get('all') !== '1' }),
    )
    return NextResponse.json({ followUps })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * A follow-up surfaces internally when it comes due and nothing leaves the company because
 * of it. Drafting the reply is a separate act a person takes (§25.7).
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const followUp = await withActor(session, (ctx, actor) =>
      body.action === 'create'
        ? createFollowUp(ctx, actor, {
            conversationId: body.conversationId,
            companyId: body.companyId,
            taskId: body.taskId,
            ownerId: body.ownerId,
            // A date, taken as midnight UTC, the same way every other due date in the
            // product is set.
            dueAt: new Date(`${body.dueOn}T00:00:00Z`),
            reason: body.reason,
          })
        : resolveFollowUp(ctx, actor, { id: body.id, resolution: body.resolution, note: body.note }),
    )
    return NextResponse.json({ followUp })
  } catch (error) {
    return errorResponse(error)
  }
}
