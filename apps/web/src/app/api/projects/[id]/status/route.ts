import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setProjectStatus } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  status: z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled']),
  reason: z.string().min(4).max(500),
})

/** Putting a project on hold, finishing it, or abandoning it (ADR 0049). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'A status change needs a status and a reason.' }, { status: 400 })
  }
  try {
    const project = await withActor(session, (ctx, actor) =>
      setProjectStatus(ctx, actor, { projectId: id, ...parsed.data }),
    )
    return NextResponse.json({ project })
  } catch (error) {
    return errorResponse(error)
  }
}
