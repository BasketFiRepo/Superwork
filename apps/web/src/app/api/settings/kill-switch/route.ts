import { NextResponse } from 'next/server'
import { z } from 'zod'
import { can } from '@superwork/auth'
import { writeActivity, writeAudit } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({ engaged: z.boolean() })

/**
 * The kill switch halts all agent execution within the organization (§4.4). Running
 * work is drained by the runtime's next gate check, and in-flight runs are marked
 * aborted_by_admin rather than silently stopping.
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Could not read the request.' }, { status: 400 })

  try {
    await withActor(session, async (ctx, actor) => {
      const decision = can(actor, 'settings:update', { type: 'settings', organizationId: ctx.organizationId })
      if (!decision.allow) throw new Error(decision.reason)

      await ctx.sql`
        UPDATE organizations SET agent_kill_switch = ${parsed.data.engaged} WHERE id = ${ctx.organizationId}`

      if (parsed.data.engaged) {
        await ctx.sql`
          UPDATE agent_runs SET status = 'aborted_by_admin', finished_at = now(),
            failure_class = 'policy',
            failure_detail = 'Halted by the organization kill switch.'
          WHERE organization_id = ${ctx.organizationId}
            AND status IN ('queued','planning','running','awaiting_approval')`
      }

      await writeActivity(ctx, {
        actorType: 'user',
        actorUserId: actor.userId,
        actorLabel: actor.displayName,
        verb: parsed.data.engaged ? 'halted' : 'resumed',
        entityType: 'organization',
        entityId: ctx.organizationId,
        entityLabel: 'Agent execution',
        summary: `${actor.displayName} ${parsed.data.engaged ? 'halted' : 're-enabled'} all agent execution.`,
      })
      await writeAudit(ctx, {
        actorType: 'user',
        actorId: actor.userId,
        action: 'settings.kill_switch',
        entityType: 'organization',
        entityId: ctx.organizationId,
        before: { agent_kill_switch: !parsed.data.engaged },
        after: { agent_kill_switch: parsed.data.engaged },
      })
    })
    return NextResponse.json({ engaged: parsed.data.engaged })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not change the setting.' },
      { status: 403 },
    )
  }
}
