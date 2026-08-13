'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Downloads everything held about the person asking. The download is itself recorded as a
 * disclosure, so the page they came from gains a row the moment it finishes (§29.3).
 */
export function PersonalExportButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/me/export', { method: 'POST' })
    setBusy(false)
    if (!response.ok) {
      setError('That could not be prepared. Nothing was recorded.')
      return
    }
    const payload = await response.json()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `superwork-personal-record-${payload.exportedAt.slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    router.refresh()
  }

  return (
    <div className="row-tight">
      {error ? <span className="small" style={{ color: 'var(--critical)' }}>{error}</span> : null}
      <button className="btn btn-sm" onClick={download} disabled={busy} data-testid="export-record">
        {busy ? 'Preparing…' : 'Download'}
      </button>
    </div>
  )
}
