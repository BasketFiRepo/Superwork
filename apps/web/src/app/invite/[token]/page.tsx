import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { login, SESSION_COOKIE } from '@superwork/auth'
import { env } from '@superwork/config'
import { acceptInvitation, invitationOffer, ValidationError } from '@superwork/core'

/**
 * Accepting an invitation (§4.1).
 *
 * Reachable by anybody holding the link, which is the whole point and also the reason this
 * page is careful: a bad token, a used one and a lapsed one all say the same thing. Telling
 * the difference would tell somebody probing which addresses had been invited.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { token } = await params
  const { error } = await searchParams
  const offer = await invitationOffer(token)

  async function accept(formData: FormData) {
    'use server'
    const name = String(formData.get('name') ?? '')
    const password = String(formData.get('password') ?? '')
    let accepted: Awaited<ReturnType<typeof acceptInvitation>> = null
    try {
      accepted = await acceptInvitation(token, { name, password })
    } catch (problem) {
      if (problem instanceof ValidationError) redirect(`/invite/${token}?error=${encodeURIComponent(problem.message)}`)
      throw problem
    }
    // The link was used, withdrawn or lapsed between loading the page and submitting it.
    if (!accepted) redirect(`/invite/${token}`)

    // Signing them straight in is the point: an invitation that ends at a login form has
    // made somebody type their new password twice for no reason.
    const result = await login(accepted.email, password)
    if (!result) redirect('/login')
    const store = await cookies()
    store.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env().NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 14,
    })
    redirect('/')
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 'var(--s-6)' }}>
      <div className="panel" style={{ width: 'min(440px, 100%)' }}>
        <div className="panel-body stack stack-6">
          <div className="stack stack-2">
            <div className="row-tight">
              <span className="dot" style={{ background: 'var(--accent)' }} />
              <span className="micro">Superwork</span>
            </div>

            {offer ? (
              <>
                <h1>Join {offer.organizationName}</h1>
                <p className="small secondary" data-testid="invite-offer">
                  {offer.invitedByName ? `${offer.invitedByName} invited` : 'You were invited'}{' '}
                  <strong className="mono">{offer.email}</strong> to join as{' '}
                  <strong>{offer.role}</strong>.
                  {offer.reason ? ` ${offer.reason}` : ''}
                </p>
              </>
            ) : (
              <>
                <h1>This link does not work</h1>
                <p className="small secondary" data-testid="invite-dead">
                  It may have been used already, withdrawn, or passed its date. Ask whoever
                  invited you to send a new one — links last 14 days and work once.
                </p>
              </>
            )}
          </div>

          {error ? (
            <div className="banner banner-critical" role="alert">
              {error}
            </div>
          ) : null}

          {offer ? (
            <form action={accept} className="stack stack-5" data-testid="invite-form">
              <label className="stack stack-2" htmlFor="name">
                <span className="micro">Your name</span>
                <input id="name" name="name" className="input" required autoComplete="name" />
              </label>
              <label className="stack stack-2" htmlFor="password">
                <span className="micro">Choose a password — at least 8 characters</span>
                <input
                  id="password"
                  name="password"
                  type="password"
                  className="input"
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </label>
              <button className="btn btn-primary" type="submit" data-testid="invite-accept">
                Join {offer.organizationName}
              </button>
              <p className="small muted" style={{ margin: 0 }}>
                Your email is fixed by the invitation — it is the address that was invited, and
                accepting cannot change it to somebody else&rsquo;s.
              </p>
            </form>
          ) : (
            <a className="btn" href="/login">
              Go to sign in
            </a>
          )}
        </div>
      </div>
    </main>
  )
}
