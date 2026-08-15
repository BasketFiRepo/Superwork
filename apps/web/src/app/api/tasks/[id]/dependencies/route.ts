import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addDependency, removeDependency, taskDependencies } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    dependsOnTaskId: z.string().uuid(),
    reason: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal('remove'), dependencyId: z.string().uuid() }),
])

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const dependencies = await withActor(session, (ctx, actor) => taskDependencies(ctx, actor, id))
    return NextResponse.json({ dependencies })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Permission is checked on the dependent task, because that is the one whose completion
 * this constrains. Cycles are refused by the trigger from 0021, not here (§12.1).
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
    const dependencies = await withActor(session, (ctx, actor) =>
      body.action === 'add'
        ? addDependency(ctx, actor, { taskId: id, dependsOnTaskId: body.dependsOnTaskId, reason: body.reason })
        : removeDependency(ctx, actor, { taskId: id, dependencyId: body.dependencyId }),
    )
    return NextResponse.json({ dependencies })
  } catch (error) {
    return errorResponse(error)
  }
}
