import { NextResponse } from 'next/server'
import { z } from 'zod'
import { listHolds, placeHold, releaseHold } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('place'),
    matter: z.string().min(3).max(200),
    basis: z.string().min(12).max(1000),
    // Empty is meaningful: a hold that names nobody covers everybody.
    custodianIds: z.array(z.string().uuid()).max(500),
    coversFrom: z.string().datetime(),
    coversTo: z.string().datetime().nullable().optional(),
  }),
  z.object({
    action: z.literal('release'),
    holdId: z.string().uuid(),
    reason: z.string().min(8).max(500),
  }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const holds = await withActor(session, (ctx, actor) => listHolds(ctx, actor))
    return NextResponse.json({ holds })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Placing needs no step-up and releasing does. The asymmetry is the whole point: preserving
 * in a hurry is what a hold is for, and letting the deletion resume is the irreversible half
 * (§4.1, §21).
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
    const hold = await withActor(session, (ctx, actor) =>
      body.action === 'place'
        ? placeHold(ctx, actor, {
            matter: body.matter,
            basis: body.basis,
            custodianIds: body.custodianIds,
            coversFrom: new Date(body.coversFrom),
            coversTo: body.coversTo ? new Date(body.coversTo) : null,
          })
        : releaseHold(ctx, actor, { holdId: body.holdId, reason: body.reason }),
    )
    return NextResponse.json({ hold })
  } catch (error) {
    return errorResponse(error)
  }
}
