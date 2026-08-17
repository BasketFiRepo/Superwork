import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  beginMfaEnrolment,
  cancelMfaEnrolment,
  confirmMfaEnrolment,
  disableMfa,
  mfaStatus,
  regenerateRecoveryCodes,
} from '@superwork/auth'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * A person's own second factor, and nobody else's (§4.1, ADR 0043).
 *
 * There is no user id in this body. An admin cannot enrol, read or remove somebody else's
 * factor from here: a factor is a proof the person holds, and an administrator who could take
 * it off would be a way around it.
 */
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('confirm'), code: z.string().min(4).max(20) }),
  z.object({ action: z.literal('disable'), code: z.string().min(4).max(30) }),
  z.object({ action: z.literal('regenerate'), code: z.string().min(4).max(30) }),
])

export async function GET() {
  const session = await requireSession()
  const status = await mfaStatus(session.userId)
  return NextResponse.json({ status })
}

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  const body = parsed.data

  if (body.action === 'begin') {
    const started = await beginMfaEnrolment(session.userId, {
      issuer: `Superwork — ${session.organizationName}`,
      account: session.email,
    })
    if ('error' in started) return NextResponse.json({ error: started.error }, { status: 409 })
    return NextResponse.json(started)
  }

  if (body.action === 'cancel') {
    await cancelMfaEnrolment(session.userId)
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'confirm') {
    const result = await confirmMfaEnrolment(session.userId, body.code)
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 })
    return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes })
  }

  if (body.action === 'regenerate') {
    const result = await regenerateRecoveryCodes(session.userId, body.code)
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 })
    return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes })
  }

  const result = await disableMfa(session.userId, { code: body.code })
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 })
  return NextResponse.json({ ok: true })
}
