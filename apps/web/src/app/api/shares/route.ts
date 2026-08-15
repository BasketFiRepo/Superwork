import { NextResponse } from 'next/server'
import { z } from 'zod'
import { listShares, share, sharedWith, unshare } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const OBJECT = z.enum(['task', 'document', 'project', 'company', 'knowledge_space'])

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('share'),
    subjectType: z.enum(['user', 'team', 'department']),
    subjectId: z.string().uuid(),
    relation: z.enum(['viewer', 'editor', 'approver', 'owner']),
    objectType: OBJECT,
    objectId: z.string().uuid(),
    reason: z.string().max(500).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  }),
  z.object({
    action: z.literal('unshare'),
    objectType: OBJECT,
    objectId: z.string().uuid(),
    tupleId: z.string().uuid(),
  }),
])

/**
 * `?objectType=&objectId=` lists who an object is shared with; no parameters lists what is
 * shared with you. Both are the same question from opposite ends (§4.6).
 */
export async function GET(request: Request) {
  const session = await requireSession()
  const url = new URL(request.url)
  const objectType = OBJECT.safeParse(url.searchParams.get('objectType'))
  const objectId = url.searchParams.get('objectId')
  try {
    const shares = await withActor(session, (ctx, actor) =>
      objectType.success && objectId
        ? listShares(ctx, actor, objectType.data, objectId)
        : sharedWith(ctx, actor, actor.userId),
    )
    return NextResponse.json({ shares })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * You can only share what you could already share — enforced in the repository against the
 * granter's own permission on the object, so a tuple can never manufacture reach.
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const shares = await withActor(session, async (ctx, actor) => {
      if (body.action === 'share') {
        await share(ctx, actor, {
          subjectType: body.subjectType,
          subjectId: body.subjectId,
          relation: body.relation,
          objectType: body.objectType,
          objectId: body.objectId,
          reason: body.reason,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        })
      } else {
        await unshare(ctx, actor, {
          objectType: body.objectType,
          objectId: body.objectId,
          tupleId: body.tupleId,
        })
      }
      return listShares(ctx, actor, body.objectType, body.objectId)
    })
    return NextResponse.json({ shares })
  } catch (error) {
    return errorResponse(error)
  }
}
