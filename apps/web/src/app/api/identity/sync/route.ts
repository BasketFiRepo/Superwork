import { NextResponse } from 'next/server'
import { applyDirectorySync, planDirectorySync } from '@superwork/core'
import { identityProvider } from '@superwork/integrations'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Preview first, apply second. The plan the admin approves is the plan that runs — it is
 * recomputed on apply so a stale page cannot deactivate somebody by accident.
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const body = await request.json().catch(() => ({}))
  const apply = body.apply === true

  try {
    const { users } = await identityProvider().users(null)
    const result = await withActor(session, async (ctx, actor) => {
      const plan = await planDirectorySync(ctx, actor, users)
      if (!apply) return { plan, applied: null }
      const applied = await applyDirectorySync(ctx, actor, plan)
      return { plan, applied }
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The directory could not be read.' },
      { status: 400 },
    )
  }
}
