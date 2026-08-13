import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  applyTriage,
  archiveConversation,
  markWaitingFor,
  snoozeConversation,
  unarchiveConversation,
} from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  action: z.enum(['archive', 'unarchive', 'snooze', 'waiting', 'clear_waiting', 'triage']),
  snoozeHours: z.number().int().min(1).max(24 * 30).optional(),
  waitingFor: z.string().max(300).optional(),
  category: z.enum(['needs_reply', 'needs_action', 'waiting_on_others', 'fyi', 'urgent', 'spam']).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'That action could not be read.' }, { status: 400 })

  try {
    await withActor(session, async (ctx, actor) => {
      switch (parsed.data.action) {
        case 'archive':
          return archiveConversation(ctx, actor, id)
        case 'unarchive':
          return unarchiveConversation(ctx, actor, id)
        case 'snooze':
          return snoozeConversation(ctx, actor, id, new Date(Date.now() + (parsed.data.snoozeHours ?? 24) * 3600_000))
        case 'waiting':
          return markWaitingFor(ctx, actor, id, parsed.data.waitingFor ?? 'a reply')
        case 'clear_waiting':
          return markWaitingFor(ctx, actor, id, null)
        case 'triage':
          await applyTriage(ctx, actor, {
            conversationId: id,
            ...(parsed.data.category ? { category: parsed.data.category } : {}),
            ...(parsed.data.priority ? { priority: parsed.data.priority } : {}),
          })
      }
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be applied.' },
      { status: 400 },
    )
  }
}
