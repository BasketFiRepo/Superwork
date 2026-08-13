import { NextResponse } from 'next/server'
import { undoRun } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const result = await undoRun(
      { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
      id,
    )
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The run could not be undone.' },
      { status: 400 },
    )
  }
}
