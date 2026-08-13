import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recordConsent } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({ participantId: z.string().uuid() })

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Could not read the request.' }, { status: 400 })

  await withActor(session, (ctx, actor) => recordConsent(ctx, actor, id, parsed.data.participantId))
  return NextResponse.json({ ok: true })
}
