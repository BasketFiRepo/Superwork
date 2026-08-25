import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { login, SESSION_COOKIE } from '@superwork/auth'
import { directorySignInOffered, signInWithAssertion } from '@superwork/core'
import { identityProvider } from '@superwork/integrations'
import { env } from '@superwork/config'

async function signIn(formData: FormData) {
  'use server'
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const result = await login(email, password)
  if (!result) redirect('/login?error=1')

  const store = await cookies()
  store.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 14,
  })
  // The cookie is set either way: the session exists, it is revocable, and until the second
  // factor is given it resolves to nothing (ADR 0043).
  redirect(result.mfaRequired ? '/login/code' : '/')
}

/**
 * The other way in (§23, ADR 0087).
 *
 * Offered only when some organization here has actually turned it on, which is what makes the
 * switch on the identity screen visible as a decision rather than a preference: turn it on, and a
 * way in appears; turn it off, and it goes. A button for a sign-in nobody accepts is the kind of
 * control this product refuses to render.
 */
async function signInWithDirectory(formData: FormData) {
  'use server'
  const assertion = String(formData.get('assertion') ?? '')
  const outcome = await signInWithAssertion(assertion, identityProvider())
  if (!outcome.ok || !outcome.session) {
    redirect(`/login?sso=${encodeURIComponent(outcome.reason)}`)
  }

  const store = await cookies()
  store.set(SESSION_COOKIE, outcome.session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 14,
  })
  redirect(outcome.session.mfaRequired ? '/login/code' : '/')
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sso?: string }>
}) {
  const params = await searchParams
  const directoryOffered = await directorySignInOffered()

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 'var(--s-6)' }}>
      <div className="panel" style={{ width: 'min(400px, 100%)' }}>
        <div className="panel-body stack stack-6">
          <div className="stack stack-2">
            <div className="row-tight">
              <span className="dot" style={{ background: 'var(--accent)' }} />
              <span className="micro">Superwork</span>
            </div>
            <h1>Sign in</h1>
            <p className="small secondary">
              The demo organization is seeded and ready. Sign in as the COO to see a full day of
              operations.
            </p>
          </div>

          {params.error ? (
            <div className="banner banner-critical" role="alert">
              That email and password did not match an account.
            </div>
          ) : null}

          <form action={signIn} className="stack stack-5">
            <label className="stack stack-2">
              <span className="micro">Email</span>
              <input
                className="input"
                name="email"
                type="email"
                required
                autoComplete="username"
                defaultValue="maya@northwind.example"
              />
            </label>
            <label className="stack stack-2">
              <span className="micro">Password</span>
              <input
                className="input"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                defaultValue="superwork"
              />
            </label>
            <button className="btn btn-primary" type="submit">
              Sign in
            </button>
          </form>

          {directoryOffered ? (
            <div className="stack stack-4 hairline-top" style={{ paddingTop: 'var(--s-5)' }} data-testid="sso-sign-in">
              <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                <span className="micro">Or sign in with the directory</span>
                <span className="chip">simulated provider</span>
              </div>
              {params.sso ? (
                <div className="banner banner-critical" role="alert" data-testid="sso-error">
                  {params.sso}
                </div>
              ) : null}
              <form action={signInWithDirectory} className="stack stack-4">
                <label className="stack stack-2">
                  <span className="micro">Assertion</span>
                  <input
                    className="input"
                    name="assertion"
                    required
                    placeholder="mock-sso:someone@example.com"
                    data-testid="sso-assertion"
                  />
                  <span className="small muted">
                    A real deployment redirects to the directory and comes back with this. The
                    simulated provider takes <code className="mono">mock-sso:</code> and an address,
                    and Superwork never reads it either way — only the provider does.
                  </span>
                </label>
                <button className="btn" type="submit" data-testid="sso-submit">
                  Sign in with the directory
                </button>
              </form>
            </div>
          ) : null}

          <p className="small muted">
            Running with AI in <code className="mono">{env().AI_MODE}</code> mode. No external
            credentials are needed — everything here reads real rows from the demo database.
          </p>
        </div>
      </div>
    </main>
  )
}
