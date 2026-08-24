import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setAttendance } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Who was actually in the room (ADR 0081).
 *
 * `attended` is nullable on purpose and the API has to be able to carry all three values, so
 * `attended` is `boolean | null` rather than optional: leaving the field out and sending `null`
 * would otherwise mean the same thing, and here they do not. `null` withdraws a record;
 * omitting it is a malformed request.
 *
 * The repository is the authority on who may say so, and the database on when — attendance
 * cannot be recorded for a meeting that has not started.
 */
const Body = z.object({
  meetingId: z.string().uuid(),
  participantId: z.string().uuid(),
  attended: z.boolean().nullable(),
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
    const participants = await withActor(session, (ctx, actor) =>
      setAttendance(ctx, actor, {
        meetingId: body.meetingId,
        participantId: body.participantId,
        attended: body.attended,
      }),
    )
    return NextResponse.json({ participants })
  } catch (error) {
    return errorResponse(error)
  }
}
