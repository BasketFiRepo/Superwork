import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setRecurrence, taskRecurrence } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * The grammar is checked in the repository, by the same `cronProblem` the workflow schedules
 * use — so "@reboot is not a schedule" is one sentence in one place rather than two that
 * drift. This only bounds the shape.
 */
const Body = z.object({
  taskId: z.string().uuid(),
  /** `null` ends the repeat; the occurrences already made stay where they are. */
  rule: z.string().max(120).nullable(),
})

export async function GET(request: Request) {
  const session = await requireSession()
  const taskId = new URL(request.url).searchParams.get('taskId')
  if (!taskId) return NextResponse.json({ error: 'Which task?' }, { status: 400 })
  try {
    const recurrence = await withActor(session, (ctx, actor) => taskRecurrence(ctx, actor, taskId))
    return NextResponse.json({ recurrence })
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
    const recurrence = await withActor(session, (ctx, actor) =>
      setRecurrence(ctx, actor, { taskId: body.taskId, rule: body.rule }),
    )
    return NextResponse.json({ recurrence })
  } catch (error) {
    return errorResponse(error)
  }
}
