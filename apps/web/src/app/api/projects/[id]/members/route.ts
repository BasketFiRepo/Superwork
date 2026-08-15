import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addProjectMember, projectRoster, removeProjectMember } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    userId: z.string().uuid(),
    // `owner` is deliberately absent: who owns a project is a property of the project, and
    // the roster's owner row is derived from it by the database (ADR 0032).
    role: z.enum(['lead', 'contributor', 'reviewer']).optional(),
    reason: z.string().min(4).max(500),
  }),
  z.object({
    action: z.literal('remove'),
    userId: z.string().uuid(),
    reason: z.string().min(4).max(500),
  }),
])

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const members = await withActor(session, (ctx, actor) => projectRoster(ctx, actor, id))
    return NextResponse.json({ members })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Putting somebody on a project is a grant of access: the project and its open work become
 * readable to them on their next request, because `loadActor` reads the roster fresh each
 * time. So it is audited as one, and it wants a reason.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const members = await withActor(session, (ctx, actor) =>
      body.action === 'add'
        ? addProjectMember(ctx, actor, {
            projectId: id,
            userId: body.userId,
            role: body.role,
            reason: body.reason,
          })
        : removeProjectMember(ctx, actor, { projectId: id, userId: body.userId, reason: body.reason }),
    )
    return NextResponse.json({ members })
  } catch (error) {
    return errorResponse(error)
  }
}
