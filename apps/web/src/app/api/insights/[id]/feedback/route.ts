import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  helpful: z.boolean(),
  // Dismissal reasons tune future thresholds per organization and per user (§9.2).
  reason: z.enum(['not_useful', 'wrong', 'already_handled', 'not_my_job']).optional(),
  status: z.enum(['acknowledged', 'in_progress', 'resolved', 'dismissed', 'snoozed']).optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'That feedback could not be read.' }, { status: 400 })

  await withActor(session, async (ctx) => {
    await ctx.sql`
      INSERT INTO insight_feedback (organization_id, insight_id, user_id, helpful, reason, created_by)
      VALUES (${ctx.organizationId}, ${id}, ${session.userId}, ${parsed.data.helpful},
              ${parsed.data.reason ?? null}, ${session.userId})`
    if (parsed.data.status) {
      await ctx.sql`
        UPDATE insights SET status = ${parsed.data.status}::sw_insight_status,
          resolved_at = CASE WHEN ${parsed.data.status} IN ('resolved','dismissed') THEN now() ELSE resolved_at END
        WHERE organization_id = ${ctx.organizationId} AND id = ${id}`
    }
  })

  return NextResponse.json({ ok: true })
}
