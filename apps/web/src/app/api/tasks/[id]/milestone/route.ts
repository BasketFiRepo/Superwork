import { NextResponse } from 'next/server'
import { z } from 'zod'
import { updateTask } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({ milestoneId: z.string().uuid().nullable() })

/**
 * Filing a task against one of its project's milestones (§17, ADR 0048).
 *
 * Through `updateTask`, so it goes past the same permission check, the same version check and
 * the same audit trail as every other change to the task — and so the repository is the one
 * place that says which milestones a task may be filed against.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'That could not be read.' }, { status: 400 })
  }
  try {
    const task = await withActor(session, (ctx, actor) =>
      updateTask(ctx, actor, { id, milestoneId: parsed.data.milestoneId }),
    )
    return NextResponse.json({ task })
  } catch (error) {
    return errorResponse(error)
  }
}
