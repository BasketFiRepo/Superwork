import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  activateWorkflow,
  getWorkflow,
  listWorkflowRuns,
  previewSchedule,
  setWorkflowSchedule,
  setWorkflowStatus,
} from '@superwork/core'
import { runWorkflow } from '@superwork/agent'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  action: z.enum(['activate', 'pause', 'archive', 'run', 'schedule', 'preview_schedule']),
  ownerUserId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
  /** `@daily` and the other aliases, or five cron fields. */
  cron: z.string().max(120).optional(),
  timezone: z.string().max(60).optional(),
  catchUpPolicy: z.enum(['skip_missed', 'run_once', 'run_all']).optional(),
  enabled: z.boolean().optional(),
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
    // Previewing saves nothing: it answers "when would this actually fire" before somebody
    // commits an automation to a clock.
    if (parsed.data.action === 'preview_schedule') {
      const preview = await withActor(session, async (ctx, actor) => {
        const workflow = await getWorkflow(ctx, actor, id)
        return previewSchedule(parsed.data.cron ?? '', parsed.data.timezone ?? workflow.scheduleTimezone ?? ctx.timezone)
      })
      return NextResponse.json({ preview })
    }

    if (parsed.data.action === 'schedule') {
      const schedule = await withActor(session, (ctx, actor) =>
        setWorkflowSchedule(ctx, actor, {
          workflowId: id,
          cron: parsed.data.cron ?? '',
          ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
          ...(parsed.data.catchUpPolicy ? { catchUpPolicy: parsed.data.catchUpPolicy } : {}),
          ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
        }),
      )
      return NextResponse.json({ schedule })
    }

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
