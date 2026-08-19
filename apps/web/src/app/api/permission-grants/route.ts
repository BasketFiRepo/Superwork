import { NextResponse } from 'next/server'
import { z } from 'zod'
import { grantPermission, listPermissionGrants, revokePermissionGrant } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Exceptions: one capability, for one person, that their role does not carry (ADR 0055).
 *
 * The repository is the authority on every rule that matters — you cannot grant what you do not
 * hold, a wildcard is not an exception, and something the role already carries is not one either.
 * This refuses only the obviously wrong shape.
 */
const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant'),
    userId: z.string().uuid(),
    permission: z.string().min(5).max(80),
    reason: z.string().min(12).max(500),
    expiresAt: z.string().datetime().nullish(),
  }),
  z.object({
    action: z.literal('revoke'),
    grantId: z.string().uuid(),
    reason: z.string().min(4).max(500),
  }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const grants = await withActor(session, (ctx, actor) => listPermissionGrants(ctx, actor))
    return NextResponse.json({ grants })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  const body = parsed.data
  try {
    const grants = await withActor(session, (ctx, actor) =>
      body.action === 'grant'
        ? grantPermission(ctx, actor, {
            userId: body.userId,
            permission: body.permission,
            reason: body.reason,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          })
        : revokePermissionGrant(ctx, actor, { grantId: body.grantId, reason: body.reason }),
    )
    return NextResponse.json({ grants })
  } catch (error) {
    return errorResponse(error)
  }
}
