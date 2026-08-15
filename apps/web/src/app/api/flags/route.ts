import { NextResponse } from 'next/server'
import { z } from 'zod'
import { clearFlag, flagStates, setFlag } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    flag: z.string().min(2).max(60),
    enabled: z.boolean(),
    scope: z.enum(['organization', 'user']),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal('clear'),
    flag: z.string().min(2).max(60),
    scope: z.enum(['organization', 'user']),
  }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const flags = await withActor(session, (ctx, actor) => flagStates(ctx, actor))
    return NextResponse.json({ flags })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Organization-wide changes need `settings:update` and a reason; a person setting their own
 * preference needs neither, and is not audited — a chosen row height is not a governance
 * event (§2.3).
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
    const flags = await withActor(session, (ctx, actor) =>
      body.action === 'set'
        ? setFlag(ctx, actor, { flag: body.flag, enabled: body.enabled, scope: body.scope, reason: body.reason })
        : clearFlag(ctx, actor, { flag: body.flag, scope: body.scope }),
    )
    return NextResponse.json({ flags })
  } catch (error) {
    return errorResponse(error)
  }
}
