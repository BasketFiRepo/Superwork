import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createProject } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Starting a project (§17, ADR 0049).
 *
 * The shape is checked here; whether this person may start one, at what classification, and
 * whether the name is free are the repository's to answer — it is the same `can()` the screen
 * asked before offering the control.
 */
const Body = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(2000).optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
  startsOn: z.string().date().nullable().optional(),
  targetDate: z.string().date().nullable().optional(),
  status: z.enum(['planning', 'active']).optional(),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  try {
    const project = await withActor(session, (ctx, actor) => createProject(ctx, actor, parsed.data))
    return NextResponse.json({ project })
  } catch (error) {
    return errorResponse(error, 'That project could not be started.')
  }
}
