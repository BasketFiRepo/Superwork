import { NextResponse } from 'next/server'
import { exportPersonalRecord } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** The subject's own copy of their record. There is no path here to anybody else's. */
export async function POST() {
  const session = await requireSession()
  try {
    const payload = await withActor(session, (ctx, actor) => exportPersonalRecord(ctx, actor))
    return NextResponse.json(payload)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be prepared.' },
      { status: 400 },
    )
  }
}
