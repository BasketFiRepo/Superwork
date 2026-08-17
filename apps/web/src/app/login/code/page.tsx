import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { completeMfaLogin, resolvePendingSession, SESSION_COOKIE } from '@superwork/auth'

/**
 * The second-factor challenge (§4.1, ADR 0043).
 *
 * The session behind this page is real and resolves to nothing: no screen, no API, no actor.
 * The only thing this page can read is whose code to ask for.
 */

async function submitCode(formData: FormData) {
  'use server'
  const code = String(formData.get('code') ?? '')
  const store = await cookies()
  const result = await completeMfaLogin(store.get(SESSION_COOKIE)?.value, code)
  if (!result.ok) redirect(`/login/code?error=${encodeURIComponent(result.reason)}`)
  redirect('/')
}

export default async function CodePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams
  const store = await cookies()
  const pending = await resolvePendingSession(store.get(SESSION_COOKIE)?.value)
  // Nothing pending: either the factor is already given or the session is gone. Either way the
  // answer is the front door, not a code box that cannot lead anywhere.
  if (!pending) redirect('/login')

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 'var(--s-6)' }}>
      <div className="panel" style={{ width: 'min(400px, 100%)' }} data-testid="mfa-challenge">
        <div className="panel-body stack stack-6">
          <div className="stack stack-2">
            <div className="row-tight">
              <span className="dot" style={{ background: 'var(--accent)' }} />
              <span className="micro">Superwork</span>
            </div>
            <h1>Your code</h1>
            <p className="small secondary">
              {pending.name}, enter the six-digit code from your authenticator app. A recovery code
              works too, and each one works once.
            </p>
          </div>

          {params.error ? (
            <div className="banner banner-critical" role="alert">
              {params.error}
            </div>
          ) : null}

          <form action={submitCode} className="stack stack-4">
            <label className="stack stack-2" htmlFor="code">
              <span className="micro">Code</span>
              <input
                id="code"
                name="code"
                className="input mono"
                autoComplete="one-time-code"
                inputMode="numeric"
                autoFocus
                placeholder="123456"
              />
            </label>
            <button className="btn btn-primary" type="submit" data-testid="mfa-submit">
              Continue
            </button>
          </form>

          <p className="small muted" style={{ margin: 0 }}>
            Until this is answered you are not signed in — the half-finished session reaches no
            screen and no data, and five wrong codes pause it on this browser only.
          </p>
        </div>
      </div>
    </main>
  )
}
