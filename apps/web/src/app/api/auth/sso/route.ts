import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { signInWithAssertion } from '@superwork/core'
import { identityProvider } from '@superwork/integrations'
import { SESSION_COOKIE } from '@superwork/auth'
import { env } from '@superwork/config'

export const dynamic = 'force-dynamic'

/**
 * Signing in with the directory (§23, ADR 0087).
 *
 * The assertion is whatever the identity provider will accept — a signed SAML response from a real
 * one, `mock-sso:<email>` from the simulated one. Superwork never parses it: `verifyAssertion` is
 * the only thing that reads it, so a deployment that swaps the provider changes what an assertion
 * is without changing a line here.
 *
 * The refusal is the same shape as the password screen's: one sentence, no detail about which of
 * the several reasons it was, except where the reason is something the person can act on — being
 * deactivated, or belonging to an organization that has not turned this on.
 */
const Body = z.object({ assertion: z.string().min(1).max(8192) })

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'That could not be read.' }, { status: 400 })
  }

  const outcome = await signInWithAssertion(parsed.data.assertion, identityProvider(), {
    userAgent: request.headers.get('user-agent') ?? undefined,
  })
  if (!outcome.ok || !outcome.session) {
    // 401 for every refusal: which of them it was is in the sentence, and the status code is not
    // the place to tell a script the difference between "no such organization" and "not a member".
    return NextResponse.json({ error: outcome.reason, refusal: outcome.refusal }, { status: 401 })
  }

  const store = await cookies()
  store.set(SESSION_COOKIE, outcome.session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 14,
  })

  return NextResponse.json({
    ok: true,
    provisioned: outcome.provisioned ?? false,
    mfaRequired: outcome.session.mfaRequired,
    next: outcome.session.mfaRequired ? '/login/code' : '/',
  })
}
