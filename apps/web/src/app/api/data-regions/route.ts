import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setAllowedRegions } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Where this organization's data may be kept (§23.4, ADR 0074).
 *
 * Narrowing the list is a promise a company makes about itself and asks for nothing but a reason.
 * Widening it back arrives as a `StepUpRequiredError` and becomes the password prompt at the
 * caller, and widening past what somebody provisioned is refused outright — a settings screen
 * cannot make a database exist. The repository is the authority on all three; this layer only
 * decides that the request is well formed.
 */
const Body = z.object({
  regions: z.array(z.string().min(2).max(8)).min(1).max(8),
  reason: z.string().min(4).max(500),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  try {
    const residency = await withActor(session, (ctx, actor) =>
      setAllowedRegions(ctx, actor, { regions: parsed.data.regions, reason: parsed.data.reason }),
    )
    return NextResponse.json({ residency })
  } catch (error) {
    return errorResponse(error)
  }
}
