import { NextResponse } from 'next/server'
import { z } from 'zod'
import { deleteSavedView, listSavedViews, saveView } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * The query is whitelisted again in the repository. This schema is the polite refusal; that
 * one is the guarantee, and it runs on read as well as on write.
 */
const Query = z.object({
  filter: z.enum(['all', 'mine', 'overdue', 'today', 'blocked', 'watching']).optional(),
  q: z.string().max(120).optional(),
  view: z.enum(['queue', 'mine', 'waiting', 'snoozed', 'archived']).optional(),
})

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    name: z.string().min(2).max(60),
    entity: z.enum(['task', 'inbox']),
    query: Query,
    shared: z.boolean().optional(),
  }),
  z.object({ action: z.literal('delete'), id: z.string().uuid() }),
])

export async function GET(request: Request) {
  const session = await requireSession()
  const entity = new URL(request.url).searchParams.get('entity') === 'inbox' ? 'inbox' : 'task'
  try {
    const views = await withActor(session, (ctx, actor) => listSavedViews(ctx, actor, entity))
    return NextResponse.json({ views })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  const body = parsed.data
  try {
    const views = await withActor(session, (ctx, actor) =>
      body.action === 'save'
        ? saveView(ctx, actor, {
            name: body.name,
            entity: body.entity,
            query: body.query,
            shared: body.shared ?? false,
          })
        : deleteSavedView(ctx, actor, { id: body.id }),
    )
    return NextResponse.json({ views })
  } catch (error) {
    return errorResponse(error)
  }
}
