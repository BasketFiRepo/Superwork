import { NextResponse } from 'next/server'
import { z } from 'zod'
import { startRun } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  request: z.string().min(1).max(4000),
  mode: z.enum(['ask', 'assist', 'execute']),
  uiContext: z.record(z.unknown()).default({}),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'That request could not be read.', detail: parsed.error.issues }, { status: 400 })
  }

  try {
    const { runId, traceId } = await startRun(
      { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
      { request: parsed.data.request, mode: parsed.data.mode, uiContext: parsed.data.uiContext, trigger: 'user' },
    )
    return NextResponse.json({ runId, traceId })
  } catch (error) {
    // Permission and budget refusals are explanations, not bare 403s (§4.2).
    return NextResponse.json({ error: error instanceof Error ? error.message : 'The run could not be started.' }, { status: 403 })
  }
}
