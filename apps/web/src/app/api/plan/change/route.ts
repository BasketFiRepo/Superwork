import { NextResponse } from 'next/server'
import { z } from 'zod'
import { cancelPlan, changePlan, planCatalogue, previewPlanChange, resumePlan } from '@superwork/core'
import { billingProvider } from '@superwork/integrations'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Changing what the company pays for (§19, ADR 0086).
 *
 * Separate from `/api/plan`, which sets the organization's own caps *within* a plan. The two are
 * different acts with different rules — tightening a cap is a setting, buying a plan costs money —
 * and the repository asks for a fresh proof of identity for this one and not for that one.
 *
 * The preview is a `GET` because it changes nothing and somebody should be able to ask what an
 * upgrade would cost without a control that looks like a purchase.
 */
const Tier = z.enum(['free', 'team', 'business', 'enterprise'])

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('change'),
    tier: Tier.optional(),
    seats: z.number().int().min(1).max(100_000).optional(),
    reason: z.string().min(6).max(500),
  }),
  z.object({ action: z.literal('cancel'), reason: z.string().min(6).max(500) }),
  z.object({ action: z.literal('resume'), reason: z.string().min(6).max(500) }),
])

export async function GET(request: Request) {
  const session = await requireSession()
  const url = new URL(request.url)
  const tier = Tier.safeParse(url.searchParams.get('tier'))
  const seatsRaw = url.searchParams.get('seats')
  const seats = seatsRaw === null ? undefined : Number(seatsRaw)
  if (seats !== undefined && (!Number.isInteger(seats) || seats < 1)) {
    return NextResponse.json({ error: 'Seats must be a whole number, one or more.' }, { status: 400 })
  }

  try {
    const data = await withActor(session, async (ctx, actor) => ({
      catalogue: await planCatalogue(ctx),
      preview: await previewPlanChange(
        ctx,
        actor,
        { ...(tier.success ? { tier: tier.data } : {}), ...(seats === undefined ? {} : { seats }) },
        billingProvider(),
      ),
    }))
    return NextResponse.json(data)
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
  const body = parsed.data

  try {
    const plan = await withActor(session, (ctx, actor) => {
      if (body.action === 'cancel') return cancelPlan(ctx, actor, body.reason)
      if (body.action === 'resume') return resumePlan(ctx, actor, body.reason)
      return changePlan(
        ctx,
        actor,
        {
          ...(body.tier ? { tier: body.tier } : {}),
          ...(body.seats === undefined ? {} : { seats: body.seats }),
          reason: body.reason,
        },
        billingProvider(),
      )
    })
    return NextResponse.json({ plan })
  } catch (error) {
    return errorResponse(error)
  }
}
