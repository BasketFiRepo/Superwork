import { NextResponse } from 'next/server'
import { z } from 'zod'
import { taskWatchers, unwatchTask, watchTask } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * You may only follow or stop following on your own behalf, which is why there is no user id
 * in this body. Adding somebody else to a watch would be a way of choosing what a colleague
 * is told about without asking them.
 */
const Body = z.object({
  action: z.enum(['watch', 'unwatch']),
  taskId: z.string().uuid(),
})

export async function GET(request: Request) {
  const session = await requireSession()
  const taskId = new URL(request.url).searchParams.get('taskId')
  if (!taskId) return NextResponse.json({ error: 'Which task?' }, { status: 400 })
  try {
    const watchers = await withActor(session, (ctx, actor) => taskWatchers(ctx, actor, taskId))
    return NextResponse.json({ watchers })
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
    const watchers = await withActor(session, (ctx, actor) =>
      body.action === 'watch' ? watchTask(ctx, actor, body.taskId) : unwatchTask(ctx, actor, body.taskId),
    )
    return NextResponse.json({ watchers })
  } catch (error) {
    return errorResponse(error)
  }
}
