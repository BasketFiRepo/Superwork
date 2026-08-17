import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { login, SESSION_COOKIE } from '@superwork/auth'
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

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams

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

          <p className="small muted">
            Running with AI in <code className="mono">{env().AI_MODE}</code> mode. No external
            credentials are needed — everything here reads real rows from the demo database.
          </p>
        </div>
      </div>
    </main>
  )
}
