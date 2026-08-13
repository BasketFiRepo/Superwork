import { NextResponse } from 'next/server'
import { z } from 'zod'
import { generateBriefing } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({ kind: z.enum(['daily', 'end_of_day']).default('daily'), force: z.boolean().default(true) })

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Could not read the request.' }, { status: 400 })

  try {
    const briefing = await generateBriefing(
      { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
      session.userId,
      parsed.data,
    )
    return NextResponse.json({ id: briefing.id, narrative: briefing.narrative, counts: briefing.facts.counts })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The briefing could not be generated.' },
      { status: 400 },
    )
  }
}
