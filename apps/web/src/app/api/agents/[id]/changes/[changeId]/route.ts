import { NextResponse } from 'next/server'
import { decideChange } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const session = await requireSession()
  const { changeId } = await params
  const body = await request.json().catch(() => ({}))
  const decision = body.decision === 'approve' ? 'approve' : 'reject'
  try {
    const change = await withActor(session, (ctx, actor) =>
      decideChange(ctx, actor, { changeRequestId: changeId, decision, note: body.note }),
    )
    return NextResponse.json(change)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That decision could not be recorded.' },
      { status: 400 },
    )
  }
}
