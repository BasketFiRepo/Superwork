'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Two-factor sign-in, on the person's own record (§4.1, ADR 0043).
 *
 * `users.mfa_enabled` was written by nothing, so there was no second factor anywhere and
 * step-up re-asked for the password the session was already opened with.
 *
 * Enrolment is two steps on purpose: a secret is generated, and it is only turned on once a
 * code from it has been proved. Turning it off asks for the factor, because otherwise it would
 * guard everything except its own removal.
 */

export function SecondFactor({
  status,
}: {
  status: { enabled: boolean; pending: boolean; recoveryCodesLeft: number; confirmedAt: string | null }
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [removing, setRemoving] = useState(false)

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/mfa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return null
    }
    return result as Record<string, unknown>
  }

  async function begin() {
    const result = await post({ action: 'begin' })
    if (!result) return
    setSecret(String(result['secret']))
    setUri(String(result['uri']))
  }

  async function confirm() {
    const result = await post({ action: 'confirm', code })
    if (!result) return
    setCodes((result['recoveryCodes'] as string[]) ?? [])
    setSecret(null)
    setUri(null)
    setCode('')
    router.refresh()
  }

  async function disable() {
    const result = await post({ action: 'disable', code })
    if (!result) return
    setRemoving(false)
    setCode('')
    setCodes(null)
    router.refresh()
  }

  async function regenerate() {
    const result = await post({ action: 'regenerate', code })
    if (!result) return
    setCodes((result['recoveryCodes'] as string[]) ?? [])
    setCode('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="second-factor">
      <div className="panel-header">
        <h2>Two-factor sign-in</h2>
        <span className="small muted">{status.enabled ? 'On' : status.pending ? 'Half set up' : 'Off'}</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {codes ? (
          <div className="banner banner-attention stack stack-2" data-testid="recovery-codes">
            <strong>Write these down now.</strong>
            <span className="small">
              Each one works once, and Superwork cannot show them to you again — they are stored as
              hashes, which is the point.
            </span>
            <code className="mono small" style={{ display: 'block', lineHeight: 1.8 }}>
              {codes.join('  ')}
            </code>
          </div>
        ) : null}

        {status.enabled ? (
          <>
            <p className="small secondary" style={{ margin: 0 }} data-testid="factor-on">
              On since {status.confirmedAt?.slice(0, 10)}. Signing in asks for a code, and so does
              confirming anything irreversible — the code replaces the password there, because a
              factor that guarded the sign-in and not the dangerous actions would be the wrong way
              round.
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              {status.recoveryCodesLeft} recovery{' '}
              {status.recoveryCodesLeft === 1 ? 'code' : 'codes'} left.
            </p>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 200px' }} htmlFor="factor-code">
                <span className="micro">A code from your app</span>
                <input
                  id="factor-code"
                  className="input mono"
                  inputMode="numeric"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="123456"
                />
              </label>
              <button
                className="btn"
                data-testid="factor-regenerate"
                disabled={busy || code.trim().length === 0}
                onClick={regenerate}
              >
                New recovery codes
              </button>
              {removing ? (
                <button className="btn btn-ghost" data-testid="factor-disable-confirm" disabled={busy} onClick={disable}>
                  {busy ? 'Turning off…' : 'Yes, turn it off'}
                </button>
              ) : (
                <button className="btn btn-ghost" data-testid="factor-disable" disabled={busy} onClick={() => setRemoving(true)}>
                  Turn it off
                </button>
              )}
            </div>
            {removing ? (
              <p className="small muted" style={{ margin: 0 }}>
                Turning it off needs a code, or a recovery code. A session on its own is not
                enough — the whole point is that a session might not be you.
              </p>
            ) : null}
          </>
        ) : secret ? (
          <div className="stack stack-3" data-testid="factor-enrolment">
            <p className="small secondary" style={{ margin: 0 }}>
              Add this to your authenticator app, then type the code it shows. Nothing is turned on
              until a code proves you can read it.
            </p>
            <code className="mono small" data-testid="factor-secret" style={{ wordBreak: 'break-all' }}>
              {secret}
            </code>
            <details>
              <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-secondary)' }}>
                Or paste the setup link
              </summary>
              <code className="mono small" style={{ wordBreak: 'break-all' }}>
                {uri}
              </code>
            </details>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 200px' }} htmlFor="factor-confirm-code">
                <span className="micro">The code it shows</span>
                <input
                  id="factor-confirm-code"
                  className="input mono"
                  inputMode="numeric"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="123456"
                />
              </label>
              <button
                className="btn btn-primary"
                data-testid="factor-confirm"
                disabled={busy || code.trim().length === 0}
                onClick={confirm}
              >
                {busy ? 'Checking…' : 'Turn it on'}
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={async () => {
                  await post({ action: 'cancel' })
                  setSecret(null)
                  setUri(null)
                  setCode('')
                  router.refresh()
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="small secondary" style={{ margin: 0 }}>
              A password opens a session; a second factor is what makes a stolen session useless.
              Superwork verifies codes itself against the standard your authenticator app already
              uses — nothing is sent anywhere and no account is created with anybody.
            </p>
            <div className="row">
              <button className="btn btn-primary" data-testid="factor-begin" disabled={busy} onClick={begin}>
                {status.pending ? 'Start again' : 'Set it up'}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
