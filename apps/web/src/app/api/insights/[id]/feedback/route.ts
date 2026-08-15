import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recordInsightFeedback } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  helpful: z.boolean(),
  // The four sentences the card offers. They are read now — a watcher people call wrong
  // stops running, and one they call "already handled" is re-timed rather than muted (§9.2).
  reason: z.enum(['not_useful', 'wrong', 'already_handled', 'not_my_job']).optional(),
  status: z.enum(['acknowledged', 'in_progress', 'resolved', 'dismissed', 'snoozed']).optional(),
})

/**
 * This used to take an actor and never use it: anybody signed in, down to a `guest` who
 * holds no insight permission at all, could rate any insight and dismiss it for the whole
 * organization. Both checks live in the repository now, where a different caller cannot
 * skip them.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That feedback could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    await withActor(session, (ctx, actor) =>
      recordInsightFeedback(ctx, actor, {
        insightId: id,
        helpful: body.helpful,
        reason: body.reason ?? null,
        status: body.status,
      }),
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
