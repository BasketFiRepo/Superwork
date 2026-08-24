'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Bringing a deferred insight back before its date (ADR 0083).
 *
 * The other half of being able to put one off. Every other deferral in this product can be
 * undone — a delegation can be taken back, an attendance record can be unrecorded — and the
 * sweep that would otherwise release this one is up to a month away.
 */
export function BringBackInsight({ insightId }: { insightId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function bringBack() {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/insights/${insightId}/snooze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That could not be read.' }))
      setError(body.error)
      return
    }
    router.refresh()
  }

  return (
    <>
      <button
        className="btn btn-ghost btn-sm"
        data-testid="insight-bring-back"
        disabled={busy}
        onClick={bringBack}
      >
        {busy ? 'Working…' : 'Bring it back'}
      </button>
      {error ? (
        <div className="small" role="alert" style={{ color: 'var(--critical)' }}>
          {error}
        </div>
      ) : null}
    </>
  )
}
