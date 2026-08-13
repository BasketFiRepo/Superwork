import { NextResponse } from 'next/server'
import { runWatchers } from '@superwork/agent'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST() {
  const session = await requireSession()
  const result = await runWatchers({
    organizationId: session.organizationId,
    userId: session.userId,
    timezone: session.timezone,
  })
  return NextResponse.json(result)
}
