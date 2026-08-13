import { NextResponse } from 'next/server'
import { summarizeMeetingRun } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const result = await summarizeMeetingRun(
      { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
      id,
    )
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The meeting could not be summarized.' },
      { status: 400 },
    )
  }
}
