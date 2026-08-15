import { NextResponse } from 'next/server'
import { z } from 'zod'
import { documentAudience, grantDocumentAccess, openDocumentToEveryone, revokeDocumentAccess } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant'),
    subjectType: z.enum(['user', 'department', 'role']),
    subjectId: z.string().uuid().nullable().optional(),
    subjectRole: z.enum(['owner', 'admin', 'manager', 'member', 'viewer', 'guest']).nullable().optional(),
    reason: z.string().min(4).max(500),
  }),
  z.object({ action: z.literal('revoke'), entryId: z.string().uuid(), reason: z.string().min(4).max(500) }),
  z.object({ action: z.literal('open'), reason: z.string().min(4).max(500) }),
])

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const audience = await withActor(session, (ctx, actor) => documentAudience(ctx, actor, id))
    return NextResponse.json({ audience })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Restricting, extending and reopening. All three are `document:update` at high risk — the
 * first grant removes the document from everybody else's retrieval, and clearing the list
 * gives it back (§4.6).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const audience = await withActor(session, (ctx, actor) => {
      if (body.action === 'grant') {
        return grantDocumentAccess(ctx, actor, {
          documentId: id,
          subjectType: body.subjectType,
          subjectId: body.subjectId ?? null,
          subjectRole: body.subjectRole ?? null,
          reason: body.reason,
        })
      }
      if (body.action === 'revoke') {
        return revokeDocumentAccess(ctx, actor, { documentId: id, entryId: body.entryId, reason: body.reason })
      }
      return openDocumentToEveryone(ctx, actor, { documentId: id, reason: body.reason })
    })
    return NextResponse.json({ audience })
  } catch (error) {
    return errorResponse(error)
  }
}
