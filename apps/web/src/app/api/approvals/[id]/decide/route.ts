import { NextResponse } from 'next/server'
import { z } from 'zod'
import { decideApproval, getApproval } from '@superwork/core'
import { continueAfterApproval } from '@superwork/agent'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  decision: z.enum(['approve', 'approve_with_edits', 'reject']),
  reason: z.string().max(2000).optional(),
  edits: z.record(z.unknown()).optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'That decision could not be read.' }, { status: 400 })
  }

  try {
    const approval = await withActor(session, async (ctx, actor) => {
      await decideApproval(ctx, actor, {
        approvalId: id,
        decision: parsed.data.decision,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.edits ? { edits: parsed.data.edits } : {}),
      })
      return getApproval(ctx, actor, id)
    })

    // Approving a plan resumes its run from the checkpoint it paused at (§5.3).
    if (approval.agentRunId && parsed.data.decision !== 'reject') {
      await continueAfterApproval(
        { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
        approval.agentRunId,
        parsed.data.edits,
      )
    }

    return NextResponse.json({ status: approval.status, runId: approval.agentRunId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The decision could not be recorded.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
