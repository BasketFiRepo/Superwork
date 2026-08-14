import { NextResponse } from 'next/server'
import { z } from 'zod'
import { retentionPolicies, setRetention } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  dataClass: z.string().min(2).max(40),
  keepDays: z.number().int().min(1).max(3650),
  reason: z.string().min(8).max(500),
})

export async function GET() {
  const session = await requireSession()
  try {
    const policies = await withActor(session, (ctx, actor) => retentionPolicies(ctx, actor))
    return NextResponse.json({ policies })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/** Changing a window requires step-up: shortening one destroys data on a schedule (§4.1). */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  try {
    const policies = await withActor(session, (ctx, actor) => setRetention(ctx, actor, parsed.data))
    return NextResponse.json({ policies })
  } catch (error) {
    return errorResponse(error)
  }
}
