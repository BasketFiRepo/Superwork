import { NextResponse } from 'next/server'
import { z } from 'zod'
import { confirmMemory, correctMemory, forgetMemory, listMemories } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), id: z.string().uuid() }),
  z.object({
    action: z.literal('correct'),
    id: z.string().uuid(),
    object: z.string().min(1).max(500),
    reason: z.string().min(4).max(500),
  }),
  z.object({ action: z.literal('forget'), id: z.string().uuid(), reason: z.string().min(4).max(500) }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const memory = await withActor(session, (ctx, actor) => listMemories(ctx, actor))
    return NextResponse.json({ memory })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Agreeing, correcting and forgetting. All three are people-only at the repository layer —
 * an assistant that could confirm its own observation would be deciding what the company
 * believes (§9.3).
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const memory = await withActor(session, async (ctx, actor) => {
      if (body.action === 'confirm') await confirmMemory(ctx, actor, body.id)
      else if (body.action === 'correct') {
        await correctMemory(ctx, actor, { id: body.id, object: body.object, reason: body.reason })
      } else await forgetMemory(ctx, actor, { id: body.id, reason: body.reason })
      return listMemories(ctx, actor)
    })
    return NextResponse.json({ memory })
  } catch (error) {
    return errorResponse(error)
  }
}
