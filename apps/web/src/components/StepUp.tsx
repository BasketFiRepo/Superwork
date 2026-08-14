'use client'

import { useCallback, useState } from 'react'

/**
 * Confirming who you are, immediately before something irreversible (§4.1).
 *
 * The server decides whether this was needed and whether it worked; this only asks. It is
 * a hook rather than a wrapper so a screen can keep its own button, its own words and its
 * own busy state — the point is one extra question, not a different flow.
 *
 * `run` performs the action and re-runs it after a successful confirmation, so the person
 * presses the button they meant to press once, rather than confirming and then pressing
 * again and wondering whether the first press did something.
 */

export interface StepUpState {
  /** Rendered wherever the screen wants the prompt to appear. */
  prompt: React.ReactNode
  /** Wrap an action that may need fresh proof. */
  run: (action: () => Promise<Response>) => Promise<Response | null>
  busy: boolean
}

export function useStepUp(): StepUpState {
  const [pending, setPending] = useState<{
    action: () => Promise<Response>
    settle: (response: Response | null) => void
  } | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Resolves only when the action has actually run — after the confirmation, if one was
   * needed. The caller stays awaited through the whole dance, so whatever it does next
   * (refresh the screen, show what changed) happens once, at the end, and happens at all.
   * An earlier version resolved as soon as the prompt appeared, and the confirmed action
   * ran without the screen ever noticing.
   */
  const run = useCallback(async (action: () => Promise<Response>): Promise<Response | null> => {
    const response = await action()
    if (response.status !== 403 && response.status !== 401) return response
    const body = await response.clone().json().catch(() => ({}))
    if (!body?.stepUpRequired) return response

    setReason(body.error ?? 'Confirm your password to continue.')
    setPassword('')
    setError(null)
    return new Promise<Response | null>((resolve) => {
      setPending({ action, settle: resolve })
    })
  }, [])

  async function confirm() {
    if (!pending) return
    setBusy(true)
    setError(null)
    const proof = await fetch('/api/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!proof.ok) {
      const body = await proof.json().catch(() => ({ error: 'That could not be checked.' }))
      setBusy(false)
      setError(body.error)
      return
    }
    const replayed = await pending.action()
    setBusy(false)
    setPending(null)
    setPassword('')
    pending.settle(replayed)
  }

  function cancel() {
    pending?.settle(null)
    setPending(null)
    setPassword('')
    setError(null)
  }

  const prompt = pending ? (
    <div className="panel" data-testid="step-up" style={{ borderColor: 'var(--attention)' }}>
      <div className="panel-body stack stack-4">
        <div className="stack stack-2">
          <span className="micro">Confirm it is you</span>
          <p className="prose small" style={{ margin: 0 }}>
            {reason}
          </p>
        </div>
        <label className="stack stack-2" htmlFor="step-up-password">
          <span className="micro">Your password</span>
          <input
            id="step-up-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && password) void confirm()
            }}
          />
        </label>
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}
        <div className="row">
          <button className="btn btn-primary" data-testid="step-up-confirm" disabled={busy || !password} onClick={confirm}>
            {busy ? 'Checking…' : 'Confirm and continue'}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Superwork asks this before the handful of things it cannot undo. The confirmation
          lasts five minutes and is recorded against what you do with it.
        </p>
      </div>
    </div>
  ) : null

  return { prompt, run, busy }
}
