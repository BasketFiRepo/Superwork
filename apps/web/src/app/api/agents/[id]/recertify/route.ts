import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recertifyAgent } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Saying an agent may still do everything it may do (ADR 0068).
 *
 * The repository is the authority on the step-up, on the note, and on there being something
 * published to stand behind. This layer only decides that the request is well formed.
 */
const Body = z.object({ note: z.string().min(8).max(1000) })

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  try {
    const agent = await withActor(session, (ctx, actor) =>
      recertifyAgent(ctx, actor, { agentId: id, note: parsed.data.note }),
    )
    return NextResponse.json({ agent })
  } catch (error) {
    return errorResponse(error)
  }
}
