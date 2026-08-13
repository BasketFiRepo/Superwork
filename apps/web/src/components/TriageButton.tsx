'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Runs classification over untriaged threads and reports honestly what it found. */
export function TriageButton({ untriaged }: { untriaged: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setNote(null)
    const response = await fetch('/api/inbox/triage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 25 }),
    })
    setBusy(false)
    if (!response.ok) {
      setNote('Triage could not run.')
      return
    }
    const result = await response.json()
    const parts = [`${result.classified} classified`]
    if (result.commitmentsProposed) parts.push(`${result.commitmentsProposed} commitments proposed`)
    if (result.flagged) parts.push(`${result.flagged} flagged for a person`)
    setNote(parts.join(' · '))
    router.refresh()
  }

  return (
    <div className="row-tight">
      {note ? <span className="small muted">{note}</span> : null}
      <button className="btn btn-sm" onClick={run} disabled={busy || untriaged === 0}>
        {busy ? 'Classifying…' : untriaged === 0 ? 'All classified' : `Classify ${untriaged}`}
      </button>
    </div>
  )
}
