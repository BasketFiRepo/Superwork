import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  organizationProfile,
  removeGlossaryTerm,
  setGlossaryTerm,
  updateOrganizationProfile,
} from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * What the organization says about itself (ADR 0052).
 *
 * The repository is the authority on whether a timezone is one this machine can work in and
 * whether money can be written in a currency; this only refuses the obviously wrong shape.
 */
const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('profile'),
    name: z.string().min(2).max(200).optional(),
    industry: z.string().max(120).nullish(),
    timezone: z.string().min(3).max(60).optional(),
    currency: z.string().min(3).max(3).optional(),
    tone: z.string().max(400).nullish(),
  }),
  z.object({
    action: z.literal('glossary.set'),
    term: z.string().min(2).max(40),
    meaning: z.string().min(2).max(200),
  }),
  z.object({ action: z.literal('glossary.remove'), term: z.string().min(1).max(40) }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const profile = await withActor(session, (ctx, actor) => organizationProfile(ctx, actor))
    return NextResponse.json({ profile })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const profile = await withActor(session, (ctx, actor) => {
      if (body.action === 'glossary.set') {
        return setGlossaryTerm(ctx, actor, { term: body.term, meaning: body.meaning })
      }
      if (body.action === 'glossary.remove') {
        return removeGlossaryTerm(ctx, actor, { term: body.term })
      }
      return updateOrganizationProfile(ctx, actor, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.industry === undefined ? {} : { industry: body.industry }),
        ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
        ...(body.currency === undefined ? {} : { currency: body.currency }),
        ...(body.tone === undefined ? {} : { tone: body.tone }),
      })
    })
    return NextResponse.json({ profile })
  } catch (error) {
    return errorResponse(error)
  }
}
