import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createTaskForCommitment } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Turning an accepted promise into the work that discharges it (ADR 0066).
 *
 * The repository is the authority on who may — the owner, or a manager above them — on the
 * promise being ours rather than theirs, and on it having been accepted first. This layer only
 * decides that the request is well formed.
 */
const Body = z.object({
  title: z.string().min(2).max(300).optional(),
  dueAt: z.string().datetime().nullable().optional(),
})

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
    const commitment = await withActor(session, (ctx, actor) =>
      createTaskForCommitment(ctx, actor, {
        commitmentId: id,
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.dueAt !== undefined
          ? { dueAt: parsed.data.dueAt === null ? null : new Date(parsed.data.dueAt) }
          : {}),
      }),
    )
    return NextResponse.json({ commitment })
  } catch (error) {
    return errorResponse(error)
  }
}
