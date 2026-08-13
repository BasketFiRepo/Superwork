import { NextResponse } from 'next/server'
import { simulateAgent } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** Runs the proposed persona through ground → plan → gate, and stops there. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    const simulation = await simulateAgent(
      { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
      { agentId: id, proposed: body.proposed, windowDays: body.windowDays ?? 7 },
    )
    return NextResponse.json(simulation)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be simulated.' },
      { status: 400 },
    )
  }
}
