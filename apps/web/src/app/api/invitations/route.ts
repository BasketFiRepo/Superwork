import { NextResponse } from 'next/server'
import { z } from 'zod'
import { inviteMember, listInvitations, revokeInvitation } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('invite'),
    email: z.string().email().max(320),
    // `owner` is absent on purpose: the repository refuses a role above the inviter's, and
    // an organization gets its owner when it is created rather than by invitation.
    role: z.enum(['admin', 'manager', 'member', 'viewer', 'guest']),
    departmentId: z.string().uuid().nullable().optional(),
    reason: z.string().min(6).max(500),
  }),
  z.object({
    action: z.literal('revoke'),
    invitationId: z.string().uuid(),
    reason: z.string().min(6).max(500),
  }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const invitations = await withActor(session, (ctx, actor) => listInvitations(ctx, actor))
    return NextResponse.json({ invitations })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * The token comes back exactly once, in the response to the request that created it.
 * Nothing is emailed — no provider in this product calls out of the process — so the
 * interface hands the link over and says so, rather than claiming a message was sent.
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
    const result = await withActor(session, async (ctx, actor) => {
      let token: string | null = null
      if (body.action === 'invite') {
        const issued = await inviteMember(ctx, actor, {
          email: body.email,
          role: body.role,
          departmentId: body.departmentId ?? null,
          reason: body.reason,
        })
        token = issued.token
      } else {
        await revokeInvitation(ctx, actor, { invitationId: body.invitationId, reason: body.reason })
      }
      return { token, invitations: await listInvitations(ctx, actor) }
    })
    return NextResponse.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}
