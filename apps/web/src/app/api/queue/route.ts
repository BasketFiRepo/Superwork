import { NextResponse } from 'next/server'
import { setQuota } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const session = await requireSession()
  const body = await request.json().catch(() => ({}))
  try {
    await withActor(session, (ctx, actor) =>
      setQuota(ctx, actor, {
        departmentId: body.departmentId ?? null,
        weight: Number(body.weight ?? 1),
        maxConcurrent: Number(body.maxConcurrent ?? 4),
        runsPerHour: Number(body.runsPerHour ?? 240),
      }),
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be saved.' },
      { status: 400 },
    )
  }
}
