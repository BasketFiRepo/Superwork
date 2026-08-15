import { NextResponse } from 'next/server'
import { z } from 'zod'
import { updateTask } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({ teamId: z.string().uuid().nullable() })

/**
 * Scoping a task to a team changes who can reach it, so it goes through `updateTask` and
 * therefore through `can()` — not a direct write (§4.3).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'That could not be read.' }, { status: 400 })
  }
  try {
    const task = await withActor(session, (ctx, actor) =>
      updateTask(ctx, actor, { id, teamId: parsed.data.teamId }),
    )
    return NextResponse.json({ task })
  } catch (error) {
    return errorResponse(error)
  }
}
