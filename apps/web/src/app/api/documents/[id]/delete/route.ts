import { NextResponse } from 'next/server'
import { z } from 'zod'
import { deleteDocument } from '@superwork/core'
import { storageProvider } from '@superwork/integrations'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({ reason: z.string().min(4).max(300) })

/**
 * Deleting a document takes its chunks, citations and derived memories with it (§25.13).
 * The response says how many of each, because "deleted" and "everything derived from it
 * went too" are different claims and only the second one is the point.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Say why it is being deleted.' }, { status: 400 })
  }
  try {
    const removed = await withActor(session, (ctx, actor) =>
      // The store goes in so §25.13 reaches the bytes: a deletion that removed only the index
      // to what somebody asked to be rid of is not a deletion (ADR 0085).
      deleteDocument(ctx, actor, { documentId: id, reason: parsed.data.reason }, storageProvider()),
    )
    return NextResponse.json({ removed })
  } catch (error) {
    return errorResponse(error, 'That could not be deleted.')
  }
}
