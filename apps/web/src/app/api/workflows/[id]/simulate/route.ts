import { NextResponse } from 'next/server'
import { simulateWorkflow } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * The dry run (§10.3.5). Reads exactly what a live run would, stops before every effect,
 * and reports what it would have done. Nothing can be activated without one.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const body = await request.json().catch(() => ({}))

  try {
    const outcome = await simulateWorkflow(
      { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
      { workflowId: id, windowDays: Math.min(Number(body.windowDays) || 30, 90) },
    )
    return NextResponse.json(outcome)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The dry run could not be completed.' },
      { status: 400 },
    )
  }
}
