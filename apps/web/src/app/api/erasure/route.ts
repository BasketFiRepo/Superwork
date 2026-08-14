import { NextResponse } from 'next/server'
import { z } from 'zod'
import { erasePerson, listErasures, previewErasure } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), subjectUserId: z.string().uuid() }),
  z.object({
    action: z.literal('erase'),
    subjectUserId: z.string().uuid(),
    reason: z.string().min(8).max(500),
  }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const erasures = await withActor(session, (ctx, actor) => listErasures(ctx, actor))
    return NextResponse.json({ erasures })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Previewing changes nothing and needs no confirmation. Erasing needs step-up, because it
 * is the least reversible thing in the product (§4.1, §21).
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closures: narrowing a property access does not survive into a
  // callback, because TypeScript cannot know when the callback runs.
  const body = parsed.data
  try {
    if (body.action === 'preview') {
      const preview = await withActor(session, (ctx, actor) =>
        previewErasure(ctx, actor, body.subjectUserId),
      )
      return NextResponse.json({ preview })
    }
    const record = await withActor(session, (ctx, actor) =>
      erasePerson(ctx, actor, { subjectUserId: body.subjectUserId, reason: body.reason }),
    )
    return NextResponse.json({ record })
  } catch (error) {
    return errorResponse(error)
  }
}
