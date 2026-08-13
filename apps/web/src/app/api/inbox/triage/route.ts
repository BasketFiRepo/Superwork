import { NextResponse } from 'next/server'
import { z } from 'zod'
import { triageInbox } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  conversationIds: z.array(z.string().uuid()).optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'That request could not be read.' }, { status: 400 })

  try {
    const result = await triageInbox(
      { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
      parsed.data,
    )
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Triage could not run.' },
      { status: 400 },
    )
  }
}
