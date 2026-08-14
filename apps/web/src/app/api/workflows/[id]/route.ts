import { NextResponse } from 'next/server'
import { z } from 'zod'
import { activateWorkflow, getWorkflow, listWorkflowRuns, setWorkflowStatus } from '@superwork/core'
import { runWorkflow } from '@superwork/agent'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  action: z.enum(['activate', 'pause', 'archive', 'run']),
  ownerUserId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
})

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const payload = await withActor(session, async (ctx, actor) => ({
      workflow: await getWorkflow(ctx, actor, id),
      runs: await listWorkflowRuns(ctx, actor, { workflowId: id, limit: 10 }),
    }))
    return NextResponse.json(payload)
  } catch {
    return NextResponse.json({ error: 'That workflow does not exist.' }, { status: 404 })
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'That action could not be read.' }, { status: 400 })

  try {
    if (parsed.data.action === 'run') {
      const outcome = await runWorkflow(
        { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
        { workflowId: id, trigger: 'manual' },
      )
      return NextResponse.json({ outcome })
    }

    const workflow = await withActor(session, (ctx, actor) =>
      parsed.data.action === 'activate'
        ? activateWorkflow(ctx, actor, {
            workflowId: id,
            ...(parsed.data.ownerUserId ? { ownerUserId: parsed.data.ownerUserId } : {}),
          })
        : setWorkflowStatus(ctx, actor, {
            workflowId: id,
            status: parsed.data.action === 'pause' ? 'paused' : 'archived',
            ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
          }),
    )
    return NextResponse.json({ workflow })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be done.' },
      { status: 400 },
    )
  }
}
