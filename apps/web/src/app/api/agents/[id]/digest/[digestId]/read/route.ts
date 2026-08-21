import { NextResponse } from 'next/server'
import { withTenant } from '@superwork/db'
import { markDigestRead } from '@superwork/agent'
import { errorResponse } from '@/lib/errors'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * The accountable human says they have read what their agent did (ADR 0070).
 *
 * No actor and no `can()`: this is somebody marking their own post read. The repository will
 * only move a row whose `recipient_user_id` is the person asking, and the database refuses a
 * receipt on a digest nobody was sent — so a request naming another person's digest changes
 * nothing and says nothing about whether it exists.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ digestId: string }> }) {
  const session = await requireSession()
  const { digestId } = await params
  try {
    const digest = await withTenant(session, (ctx) =>
      markDigestRead(ctx, { userId: session.userId }, digestId),
    )
    return NextResponse.json({ readAt: digest?.readAt ?? null })
  } catch (error) {
    return errorResponse(error)
  }
}
