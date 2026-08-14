import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { SESSION_COOKIE, stepUp } from '@superwork/auth'
import { STEP_UP_ACTIONS, STEP_UP_MAX_AGE_MS } from '@superwork/core'

export const dynamic = 'force-dynamic'

const Body = z.object({ password: z.string().min(1).max(200) })

/**
 * Step-up authentication (§4.1). The person proves, again and just now, that they are the
 * one at the keyboard — immediately before something that cannot be undone.
 *
 * The result is stamped on the *session*, not returned as a token: nothing the browser
 * holds decides whether the proof happened, and the same person in another tab has not
 * re-authenticated because this one did.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter your password.' }, { status: 400 })
  }

  const store = await cookies()
  const result = await stepUp(store.get(SESSION_COOKIE)?.value, parsed.data.password)
  if (!result.ok) {
    // 401 rather than 403: the caller can fix this by proving who they are.
    return NextResponse.json(
      { error: result.reason, ...(result.lockedUntil ? { lockedUntil: result.lockedUntil.toISOString() } : {}) },
      { status: 401 },
    )
  }

  return NextResponse.json({
    steppedUpAt: result.steppedUpAt.toISOString(),
    expiresInSeconds: Math.round(STEP_UP_MAX_AGE_MS / 1000),
    actions: STEP_UP_ACTIONS,
  })
}
