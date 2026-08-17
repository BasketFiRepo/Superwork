import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setEffectiveDates } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Closing a term takes a document out of every current answer the assistant gives, so it
 * needs a say over the document rather than a read of it. The repository is the authority on
 * that and on the ordering of the two dates (ADR 0042).
 */
const Body = z.object({
  documentId: z.string().uuid(),
  effectiveFrom: z.string().date().nullable().optional(),
  effectiveTo: z.string().date().nullable().optional(),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  const body = parsed.data
  try {
    const document = await withActor(session, (ctx, actor) =>
      setEffectiveDates(ctx, actor, {
        documentId: body.documentId,
        ...(body.effectiveFrom === undefined ? {} : { effectiveFrom: body.effectiveFrom }),
        ...(body.effectiveTo === undefined ? {} : { effectiveTo: body.effectiveTo }),
      }),
    )
    return NextResponse.json({ document })
  } catch (error) {
    return errorResponse(error)
  }
}
