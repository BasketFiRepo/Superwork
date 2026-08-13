import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAgentDraft } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  key: z.string().min(3).max(40),
  name: z.string().min(1).max(80),
  purpose: z.string().min(1).max(2000),
  scopeDepartmentId: z.string().uuid().nullable().optional(),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'A key, a name and a purpose are required.' }, { status: 400 })
  }
  try {
    const agent = await withActor(session, (ctx, actor) =>
      createAgentDraft(ctx, actor, {
        key: parsed.data.key,
        name: parsed.data.name,
        purpose: parsed.data.purpose,
        scopeDepartmentId: parsed.data.scopeDepartmentId ?? null,
      }),
    )
    return NextResponse.json(agent)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be created.' },
      { status: 400 },
    )
  }
}
