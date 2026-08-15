import { NextResponse } from 'next/server'
import { z } from 'zod'
import { archiveSpace, createSpace, listSpaces, updateSpace } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().min(2).max(120),
    description: z.string().max(500).nullish(),
    defaultSensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
    departmentId: z.string().uuid().nullish(),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string().uuid(),
    name: z.string().min(2).max(120).optional(),
    description: z.string().max(500).nullish(),
    departmentId: z.string().uuid().nullish(),
  }),
  z.object({ action: z.literal('archive'), id: z.string().uuid(), reason: z.string().min(4).max(500) }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const spaces = await withActor(session, (ctx, actor) => listSpaces(ctx, actor))
    return NextResponse.json({ spaces })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const spaces = await withActor(session, (ctx, actor) => {
      if (body.action === 'create') {
        return createSpace(ctx, actor, {
          name: body.name,
          description: body.description,
          defaultSensitivity: body.defaultSensitivity,
          departmentId: body.departmentId,
        })
      }
      if (body.action === 'update') {
        return updateSpace(ctx, actor, {
          id: body.id,
          name: body.name,
          description: body.description,
          departmentId: body.departmentId,
        })
      }
      return archiveSpace(ctx, actor, { id: body.id, reason: body.reason })
    })
    return NextResponse.json({ spaces })
  } catch (error) {
    return errorResponse(error)
  }
}
