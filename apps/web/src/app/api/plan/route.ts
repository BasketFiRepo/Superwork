import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setOrganizationCaps, subscription } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  // Null means "use the plan's own". There is no value that raises one — the repository
  // refuses anything above the plan, because a limit a tenant can widen is not a limit.
  aiSpendCapCents: z.number().int().min(0).max(100_000_000).nullable(),
  perUserDailyCapCents: z.number().int().min(0).max(100_000_000).nullable(),
  reason: z.string().min(6).max(500),
})

export async function GET() {
  const session = await requireSession()
  try {
    const plan = await withActor(session, (ctx, actor) => subscription(ctx, actor))
    return NextResponse.json({ plan })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const plan = await withActor(session, (ctx, actor) =>
      setOrganizationCaps(ctx, actor, {
        aiSpendCapCents: body.aiSpendCapCents,
        perUserDailyCapCents: body.perUserDailyCapCents,
        reason: body.reason,
      }),
    )
    return NextResponse.json({ plan })
  } catch (error) {
    return errorResponse(error)
  }
}
