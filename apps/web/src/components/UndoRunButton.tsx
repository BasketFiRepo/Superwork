'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Undo replays each recorded inverse in reverse order and reports anything it could not reverse. */
export function UndoRunButton({ runId, count }: { runId: string; count: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function undo() {
    setBusy(true)
    const response = await fetch(`/api/runs/${runId}/undo`, { method: 'POST' })
    const body = await response.json()
    setBusy(false)
    setNote(body.narrative ?? body.error ?? 'Nothing to undo.')
    router.refresh()
  }

  return (
    <div className="row-tight">
      <button className="btn btn-danger btn-sm" onClick={undo} disabled={busy || count === 0}>
        {busy ? 'Reversing…' : `Undo this run (${count})`}
      </button>
      {note ? <span className="small muted">{note}</span> : null}
    </div>
  )
}
