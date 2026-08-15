import { NextResponse } from 'next/server'
import { z } from 'zod'
import { archiveDepartment, createDepartment, listDepartments, updateDepartment } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().min(2).max(120),
    parentId: z.string().uuid().nullish(),
    timezone: z.string().max(60).nullish(),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string().uuid(),
    name: z.string().min(2).max(120).optional(),
    parentId: z.string().uuid().nullish(),
    // `null` clears it, so the department goes back to inheriting. The repository is the
    // authority on which names are real; this only refuses the obviously wrong shape.
    holidayCalendar: z.string().max(40).nullish(),
  }),
  z.object({ action: z.literal('archive'), id: z.string().uuid(), reason: z.string().min(4).max(500) }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const departments = await withActor(session, (ctx, actor) => listDepartments(ctx, actor))
    return NextResponse.json({ departments })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * A department decides what `department`-scoped permissions reach, so creating and moving
 * them is org structure — the same gate that governs teams and membership.
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
    const departments = await withActor(session, (ctx, actor) => {
      if (body.action === 'create') {
        return createDepartment(ctx, actor, {
          name: body.name,
          parentId: body.parentId,
          timezone: body.timezone,
        })
      }
      if (body.action === 'update') {
        return updateDepartment(ctx, actor, {
          id: body.id,
          name: body.name,
          parentId: body.parentId,
          ...(body.holidayCalendar === undefined ? {} : { holidayCalendar: body.holidayCalendar }),
        })
      }
      return archiveDepartment(ctx, actor, { id: body.id, reason: body.reason })
    })
    return NextResponse.json({ departments })
  } catch (error) {
    return errorResponse(error)
  }
}
