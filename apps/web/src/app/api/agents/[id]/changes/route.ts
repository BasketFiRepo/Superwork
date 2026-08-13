import { NextResponse } from 'next/server'
import { requestChange } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    const change = await withActor(session, (ctx, actor) =>
      requestChange(ctx, actor, {
        agentId: id,
        proposed: body.proposed,
        justification: String(body.justification ?? ''),
        simulationId: body.simulationId ?? null,
      }),
    )
    return NextResponse.json(change)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be proposed.' },
      { status: 400 },
    )
  }
}
