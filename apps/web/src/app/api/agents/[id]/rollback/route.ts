import { NextResponse } from 'next/server'
import { rollbackAgent } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    const agent = await withActor(session, (ctx, actor) =>
      rollbackAgent(ctx, actor, { agentId: id, versionId: String(body.versionId ?? ''), reason: String(body.reason ?? '') }),
    )
    return NextResponse.json(agent)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be rolled back.' },
      { status: 400 },
    )
  }
}
