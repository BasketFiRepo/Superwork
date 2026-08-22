import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recordMessage } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Writing down correspondence that reached somebody another way (§12.3, ADR 0076).
 *
 * There is no `trustLevel` in this schema and there must never be one. The repository derives it
 * from the direction, so an inbound message is `untrusted_external` and gets the injection scan;
 * a field here would be a way to paste an instruction into the product and ask for it to be
 * marked safe.
 */
const Body = z.object({
  conversationId: z.string().uuid().optional(),
  subject: z.string().min(2).max(500).optional(),
  companyId: z.string().uuid().nullish(),
  channel: z.literal('email').optional(),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  fromAddress: z.string().min(3).max(320),
  fromName: z.string().max(200).nullish(),
  toAddresses: z.array(z.string().min(3).max(320)).max(50).optional(),
  sentAt: z.string().datetime().optional(),
  body: z.string().min(2).max(100_000),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  const input = parsed.data
  try {
    const recorded = await withActor(session, (ctx, actor) =>
      recordMessage(ctx, actor, {
        conversationId: input.conversationId,
        subject: input.subject,
        companyId: input.companyId ?? null,
        channel: input.channel,
        direction: input.direction,
        fromAddress: input.fromAddress,
        fromName: input.fromName ?? null,
        toAddresses: input.toAddresses,
        sentAt: input.sentAt ? new Date(input.sentAt) : undefined,
        body: input.body,
      }),
    )
    return NextResponse.json(recorded)
  } catch (error) {
    return errorResponse(error)
  }
}
