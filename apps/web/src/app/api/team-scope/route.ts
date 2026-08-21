import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setTeamScope } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Putting work in a team, or taking it out (ADR 0064).
 *
 * One route for tasks, projects and documents, because it is one act: the repository is the
 * authority on who may do it, on the team being a live one in this organization, and on the
 * reason being there. This layer only decides that the request is well formed.
 */
const Body = z.object({
  entity: z.enum(['task', 'project', 'document']),
  id: z.string().uuid(),
  teamId: z.string().uuid().nullable(),
  reason: z.string().min(4).max(500),
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
    const scope = await withActor(session, (ctx, actor) =>
      setTeamScope(ctx, actor, {
        entity: body.entity,
        id: body.id,
        teamId: body.teamId,
        reason: body.reason,
      }),
    )
    return NextResponse.json({ scope })
  } catch (error) {
    return errorResponse(error)
  }
}
