import { NextResponse } from 'next/server'
import { z } from 'zod'
import { respondToCommitment } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  response: z.enum(['confirm', 'dispute', 'renegotiate', 'complete', 'cancel']),
  newDueAt: z.string().datetime().optional(),
  reason: z.string().max(1000).optional(),
  note: z.string().max(1000).optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Could not read the response.' }, { status: 400 })

  try {
    const commitment = await withActor(session, (ctx, actor) =>
      respondToCommitment(ctx, actor, {
        commitmentId: id,
        response: parsed.data.response,
        ...(parsed.data.newDueAt ? { newDueAt: new Date(parsed.data.newDueAt) } : {}),
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
      }),
    )
    return NextResponse.json({ status: commitment.status })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That response could not be recorded.' },
      { status: 400 },
    )
  }
}
