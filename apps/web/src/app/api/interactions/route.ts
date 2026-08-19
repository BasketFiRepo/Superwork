import { NextResponse } from 'next/server'
import { z } from 'zod'
import { INTERACTION_KINDS, logInteraction } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Logging what was said, and when (ADR 0057).
 *
 * The repository holds the rules: the same `note:create` gate the tool declares, a kind from the
 * one vocabulary, something for it to be about, and nothing dated in the future.
 */
const Body = z.object({
  companyId: z.string().uuid().nullish(),
  contactId: z.string().uuid().nullish(),
  kind: z.enum(INTERACTION_KINDS),
  direction: z.enum(['inbound', 'outbound', 'internal']).nullish(),
  summary: z.string().min(3).max(2000),
  occurredAt: z.string().datetime().nullish(),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  const body = parsed.data
  try {
    const id = await withActor(session, (ctx, actor) =>
      logInteraction(ctx, actor, {
        companyId: body.companyId ?? null,
        contactId: body.contactId ?? null,
        kind: body.kind,
        summary: body.summary,
        ...(body.direction ? { direction: body.direction } : {}),
        ...(body.occurredAt ? { occurredAt: new Date(body.occurredAt) } : {}),
      }),
    )
    return NextResponse.json({ id })
  } catch (error) {
    return errorResponse(error)
  }
}
