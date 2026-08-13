'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Reachable in two clicks from any screen for an admin (§27.4). */
export function KillSwitch({ engaged }: { engaged: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle(next: boolean) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/settings/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engaged: next }),
    })
    setBusy(false)
    setConfirming(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Could not change the setting.' }))
      setError(body.error)
      return
    }
    router.refresh()
  }

  return (
    <section className={`banner ${engaged ? 'banner-critical' : 'banner-attention'}`}>
      <div className="stack stack-3 grow">
        <strong>{engaged ? 'Agent execution is halted' : 'Kill switch'}</strong>
        <span>
          {engaged
            ? 'No agent run can start or continue anywhere in this organization. In-flight runs were marked aborted by admin.'
            : 'Halts every agent run in this organization within five seconds, drains the queues, and marks in-flight runs aborted by admin.'}
        </span>
        {error ? <span>{error}</span> : null}
        <div className="row">
          {engaged ? (
            <button className="btn btn-sm" onClick={() => toggle(false)} disabled={busy}>
              {busy ? 'Resuming…' : 'Re-enable agent execution'}
            </button>
          ) : confirming ? (
            <>
              <button className="btn btn-danger btn-sm" onClick={() => toggle(true)} disabled={busy}>
                {busy ? 'Halting…' : 'Yes, halt everything'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-danger btn-sm" onClick={() => setConfirming(true)}>
              Halt all agent execution
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
