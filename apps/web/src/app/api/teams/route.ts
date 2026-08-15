import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addTeamMember, archiveTeam, createTeam, listTeams, removeTeamMember, updateTeam } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().min(2).max(120),
    purpose: z.string().max(500).nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
  }),
  z.object({
    action: z.literal('update'),
    teamId: z.string().uuid(),
    name: z.string().min(2).max(120).optional(),
    purpose: z.string().max(500).nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
  }),
  z.object({ action: z.literal('archive'), teamId: z.string().uuid(), reason: z.string().min(4).max(500) }),
  z.object({
    action: z.literal('add_member'),
    teamId: z.string().uuid(),
    userId: z.string().uuid(),
    role: z.enum(['lead', 'member']).optional(),
    reason: z.string().min(4).max(500),
  }),
  z.object({
    action: z.literal('remove_member'),
    teamId: z.string().uuid(),
    userId: z.string().uuid(),
    reason: z.string().min(4).max(500),
  }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const teams = await withActor(session, (ctx, actor) => listTeams(ctx, actor))
    return NextResponse.json({ teams })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Membership is a grant of access, not an org-chart edit: everything scoped to the team
 * becomes readable on the member's next request, because `loadActor` reads membership
 * fresh each time (§4.3).
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
    const teams = await withActor(session, async (ctx, actor) => {
      if (body.action === 'create') {
        await createTeam(ctx, actor, { name: body.name, purpose: body.purpose, departmentId: body.departmentId })
      } else if (body.action === 'update') {
        await updateTeam(ctx, actor, {
          teamId: body.teamId,
          name: body.name,
          purpose: body.purpose,
          departmentId: body.departmentId,
        })
      } else if (body.action === 'archive') {
        await archiveTeam(ctx, actor, { teamId: body.teamId, reason: body.reason })
      } else if (body.action === 'add_member') {
        await addTeamMember(ctx, actor, {
          teamId: body.teamId,
          userId: body.userId,
          role: body.role,
          reason: body.reason,
        })
      } else {
        await removeTeamMember(ctx, actor, { teamId: body.teamId, userId: body.userId, reason: body.reason })
      }
      return listTeams(ctx, actor)
    })
    return NextResponse.json({ teams })
  } catch (error) {
    return errorResponse(error)
  }
}
