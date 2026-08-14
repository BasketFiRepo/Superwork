import { NextResponse } from 'next/server'
import { z } from 'zod'
import { can } from '@superwork/auth'
import { previewSchedule } from '@superwork/core'
import { setWatcherSchedule, watcherSchedules } from '@superwork/agent'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  action: z.enum(['schedule', 'preview_schedule', 'enable', 'disable']),
  key: z.string().min(2).max(60),
  cron: z.string().max(120).optional(),
})

export async function GET() {
  const session = await requireSession()
  const watchers = await withActor(session, (ctx) => watcherSchedules(ctx))
  return NextResponse.json({ watchers })
}

/**
 * Re-timing a watcher is a settings change, so it needs the permission a settings change
 * needs — checked here as well as anywhere else that reaches the same repository.
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'That could not be read.' }, { status: 400 })
  }

  try {
    const result = await withActor(session, async (ctx, actor) => {
      const decision = can(actor, 'settings:update', {
        type: 'settings',
        organizationId: ctx.organizationId,
        riskTier: 'low',
      })
      if (!decision.allow) throw new Error(decision.reason)

      if (parsed.data.action === 'preview_schedule') {
        return { preview: previewSchedule(parsed.data.cron ?? '', ctx.timezone) }
      }
      if (parsed.data.action === 'schedule') {
        return { watcher: await setWatcherSchedule(ctx, { key: parsed.data.key, cron: parsed.data.cron ?? '' }) }
      }
      return {
        watcher: await setWatcherSchedule(ctx, {
          key: parsed.data.key,
          enabled: parsed.data.action === 'enable',
        }),
      }
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be done.' },
      { status: 400 },
    )
  }
}
