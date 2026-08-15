import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  answerReminder,
  listNotifications,
  listReminders,
  markNotificationsRead,
  setNotificationPreferences,
} from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('answer'),
    nudgeId: z.string().uuid(),
    response: z.enum(['done', 'snooze', 'renegotiate', 'reassign', 'blocked']),
    note: z.string().max(500).optional(),
    newDueAt: z.string().date().optional(),
    reassignTo: z.string().uuid().optional(),
  }),
  z.object({ action: z.literal('mark_read'), ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() }),
  z.object({
    action: z.literal('preferences'),
    briefingHour: z.number().int().min(0).max(23).optional(),
    endOfDayHour: z.number().int().min(0).max(23).optional(),
    briefingEnabled: z.boolean().optional(),
  }),
])

/** Only ever your own — the repository refuses any other user id, including for an admin. */
export async function GET() {
  const session = await requireSession()
  try {
    const payload = await withActor(session, async (ctx, actor) => ({
      reminders: await listReminders(ctx, actor),
      notifications: await listNotifications(ctx, actor),
    }))
    return NextResponse.json(payload)
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const payload = await withActor(session, async (ctx, actor) => {
      if (body.action === 'answer') {
        const outcome = await answerReminder(ctx, actor, {
          nudgeId: body.nudgeId,
          action: body.response,
          note: body.note,
          // Parsed as a plain date in the person's own timezone would need a tz-aware
          // parse; the API takes a date and the repository stores an instant, so midnight
          // UTC is used deliberately and consistently with how due dates are set elsewhere.
          newDueAt: body.newDueAt ? new Date(`${body.newDueAt}T00:00:00Z`) : null,
          reassignTo: body.reassignTo ?? null,
        })
        return { outcome }
      }
      if (body.action === 'mark_read') {
        return { read: await markNotificationsRead(ctx, actor, { ids: body.ids, all: body.all }) }
      }
      return {
        preferences: await setNotificationPreferences(ctx, actor, {
          briefingHour: body.briefingHour,
          endOfDayHour: body.endOfDayHour,
          briefingEnabled: body.briefingEnabled,
        }),
      }
    })
    return NextResponse.json(payload)
  } catch (error) {
    return errorResponse(error)
  }
}
