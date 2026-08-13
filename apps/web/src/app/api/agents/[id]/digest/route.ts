import { NextResponse } from 'next/server'
import { generateDigest } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const digest = await generateDigest(
      { organizationId: session.organizationId, userId: session.userId, timezone: session.timezone },
      { agentId: id, weeksAgo: 1 },
    )
    return NextResponse.json(digest ?? { error: 'Nothing to report.' })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be written.' },
      { status: 400 },
    )
  }
}
