import { NextResponse } from 'next/server'
import { z } from 'zod'
import { connectMailbox, disconnectMailbox, reconnectMailbox } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Connecting, reconnecting and disconnecting a mailbox (ADR 0084).
 *
 * The repository is the authority on the one rule that matters: a person connects their own
 * mailbox and nobody else's. There is no field here for whose it is, and that is deliberate —
 * an endpoint that accepted a `userId` would be one request away from a manager connecting a
 * colleague's mail.
 */
const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('connect'),
    address: z.string().min(3).max(320),
    provider: z.string().max(40).optional(),
  }),
  z.object({ action: z.literal('reconnect'), mailboxId: z.string().uuid() }),
  z.object({ action: z.literal('disconnect'), mailboxId: z.string().uuid() }),
])

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
    await withActor(session, async (ctx, actor) => {
      if (body.action === 'connect') {
        await connectMailbox(ctx, actor, {
          address: body.address,
          ...(body.provider ? { provider: body.provider } : {}),
        })
      } else if (body.action === 'reconnect') {
        await reconnectMailbox(ctx, actor, body.mailboxId)
      } else {
        await disconnectMailbox(ctx, actor, body.mailboxId)
      }
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
