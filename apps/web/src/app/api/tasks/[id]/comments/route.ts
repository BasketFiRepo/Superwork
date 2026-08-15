import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addTaskComment, deleteTaskComment, taskComments } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    body: z.string().min(1).max(4000),
    mentions: z.array(z.string().uuid()).max(20).optional(),
  }),
  z.object({ action: z.literal('remove'), commentId: z.string().uuid() }),
])

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const comments = await withActor(session, (ctx, actor) => taskComments(ctx, actor, id))
    return NextResponse.json({ comments })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * A comment needs only a read of the task: discussing work you can see is not changing it.
 * A mention writes a notification, which is what makes naming somebody mean anything — the
 * array has been on the row since Phase 0 and was never populated.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const comments = await withActor(session, (ctx, actor) =>
      body.action === 'add'
        ? addTaskComment(ctx, actor, { taskId: id, body: body.body, mentions: body.mentions })
        : deleteTaskComment(ctx, actor, { taskId: id, commentId: body.commentId }),
    )
    return NextResponse.json({ comments })
  } catch (error) {
    return errorResponse(error)
  }
}
