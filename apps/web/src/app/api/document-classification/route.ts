import { NextResponse } from 'next/server'
import { z } from 'zod'
import { reclassifyAutomatically, reclassifyDocument } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Reclassifying a document (§4.3, ADR 0044).
 *
 * Lowering asks for a fresh proof of identity, which arrives as a `StepUpRequiredError` and is
 * turned into the password prompt by the caller. The repository is the authority on that, on the
 * reader's own ceiling, and on the reason being present.
 */
const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    documentId: z.string().uuid(),
    sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
    reason: z.string().min(4).max(500),
  }),
  z.object({
    action: z.literal('hand_back'),
    documentId: z.string().uuid(),
    reason: z.string().min(4).max(500),
  }),
])

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  const body = parsed.data
  try {
    const document = await withActor(session, (ctx, actor) =>
      body.action === 'set'
        ? reclassifyDocument(ctx, actor, {
            documentId: body.documentId,
            sensitivity: body.sensitivity,
            reason: body.reason,
          })
        : reclassifyAutomatically(ctx, actor, { documentId: body.documentId, reason: body.reason }),
    )
    return NextResponse.json({ document })
  } catch (error) {
    return errorResponse(error)
  }
}
