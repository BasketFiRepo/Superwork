import { NextResponse } from 'next/server'
import { setAgentStatus } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const status = ['active', 'paused', 'retired'].includes(body.status) ? body.status : null
  if (!status) return NextResponse.json({ error: 'Unknown status.' }, { status: 400 })
  try {
    const agent = await withActor(session, (ctx, actor) =>
      setAgentStatus(ctx, actor, { agentId: id, status, reason: body.reason }),
    )
    return NextResponse.json(agent)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be changed.' },
      { status: 400 },
    )
  }
}
