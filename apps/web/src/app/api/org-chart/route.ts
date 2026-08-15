import { NextResponse } from 'next/server'
import { z } from 'zod'
import { orgChart, removeReportingLine, setReportingLine } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    personId: z.string().uuid(),
    managerId: z.string().uuid(),
    type: z.enum(['functional', 'dotted']),
    reason: z.string().min(6).max(500),
  }),
  z.object({
    action: z.literal('remove'),
    lineId: z.string().uuid(),
    reason: z.string().min(6).max(500),
  }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const lines = await withActor(session, (ctx, actor) => orgChart(ctx, actor))
    return NextResponse.json({ lines })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Setting a line is not step-up protected. It changes where an escalation goes and who may
 * be asked to decide something — it does not open a view onto anybody, because there is no
 * such view to open (§29.5). The reason is required instead, because a chart nobody can
 * account for is a chart nobody will correct.
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const lines = await withActor(session, async (ctx, actor) => {
      if (body.action === 'set') {
        await setReportingLine(ctx, actor, {
          personId: body.personId,
          managerId: body.managerId,
          type: body.type,
          reason: body.reason,
        })
      } else {
        await removeReportingLine(ctx, actor, { lineId: body.lineId, reason: body.reason })
      }
      return orgChart(ctx, actor)
    })
    return NextResponse.json({ lines })
  } catch (error) {
    return errorResponse(error)
  }
}
