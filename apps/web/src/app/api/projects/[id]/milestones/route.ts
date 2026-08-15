import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addMilestone, projectMilestones, removeMilestone, rescheduleMilestone, setMilestoneStatus } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), name: z.string().min(2).max(200), dueOn: z.string().date().nullish() }),
  z.object({
    action: z.literal('status'),
    milestoneId: z.string().uuid(),
    status: z.enum(['open', 'done', 'cancelled']),
  }),
  z.object({
    action: z.literal('reschedule'),
    milestoneId: z.string().uuid(),
    dueOn: z.string().date().nullish(),
  }),
  z.object({ action: z.literal('remove'), milestoneId: z.string().uuid() }),
])

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    // The project's own read gate: `projectMilestones` is scoped by the caller having
    // opened the project, so this asks for it first.
    const milestones = await withActor(session, async (ctx, actor) => {
      const { getProject } = await import('@superwork/core')
      await getProject(ctx, actor, id)
      return projectMilestones(ctx, id)
    })
    return NextResponse.json({ milestones })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

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
    const milestones = await withActor(session, (ctx, actor) => {
      if (body.action === 'add') {
        // A date, taken as midnight UTC, the same way every other due date is set here.
        return addMilestone(ctx, actor, {
          projectId: id,
          name: body.name,
          dueOn: body.dueOn ? new Date(`${body.dueOn}T00:00:00Z`) : null,
        })
      }
      if (body.action === 'status') {
        return setMilestoneStatus(ctx, actor, {
          projectId: id,
          milestoneId: body.milestoneId,
          status: body.status,
        })
      }
      if (body.action === 'reschedule') {
        return rescheduleMilestone(ctx, actor, {
          projectId: id,
          milestoneId: body.milestoneId,
          dueOn: body.dueOn ? new Date(`${body.dueOn}T00:00:00Z`) : null,
        })
      }
      return removeMilestone(ctx, actor, { projectId: id, milestoneId: body.milestoneId })
    })
    return NextResponse.json({ milestones })
  } catch (error) {
    return errorResponse(error)
  }
}
