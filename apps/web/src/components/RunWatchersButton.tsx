'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Runs the read-only watchers on demand. Reports honestly what it suppressed (§9.3). */
export function RunWatchersButton({ label = 'Check for new insights' }: { label?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setNote(null)
    const response = await fetch('/api/watchers/run', { method: 'POST' })
    setBusy(false)
    if (!response.ok) {
      setNote('The watchers could not run.')
      return
    }
    const result = await response.json()
    const parts = [`${result.created} new`]
    if (result.deduped) parts.push(`${result.deduped} already raised`)
    if (result.suppressed) parts.push(`${result.suppressed} held back by the daily cap`)
    // Muting is no longer one rule with one number behind it, so the summary counts them
    // and the row on the screen below says which watcher and why.
    if (result.muted?.length) {
      parts.push(`${result.muted.length} muted by what people said about them — see the rows below`)
    }
    setNote(parts.join(' · '))
    router.refresh()
  }

  return (
    <div className="row-tight">
      {note ? <span className="small muted">{note}</span> : null}
      <button className="btn btn-sm" onClick={run} disabled={busy}>
        {busy ? 'Checking…' : label}
      </button>
    </div>
  )
}
